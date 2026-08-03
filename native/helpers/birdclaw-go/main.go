package main

import (
	"archive/zip"
	"bufio"
	"container/heap"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	helperVersion   = "0.2.0"
	protocolVersion = 1
	defaultLimit    = 5000
)

var (
	dmEntryPattern        = regexp.MustCompile(`(?i)(?:^|/)data/direct-messages(?:-group)?(?:-part\d+)?\.js$`)
	tweetEntryPattern     = regexp.MustCompile(`(?i)(?:^|/)data/tweets(?:-part\d+)?\.js$`)
	followerEntryPattern  = regexp.MustCompile(`(?i)(?:^|/)data/follower(?:-part\d+)?\.js$`)
	followingEntryPattern = regexp.MustCompile(`(?i)(?:^|/)data/following(?:-part\d+)?\.js$`)
)

type accountRow struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Handle         string `json:"handle"`
	ExternalUserID string `json:"external_user_id"`
}

type profileRow struct {
	ID             string `json:"id"`
	Handle         string `json:"handle"`
	DisplayName    string `json:"display_name"`
	Bio            string `json:"bio"`
	FollowersCount int    `json:"followers_count"`
	FollowingCount int    `json:"following_count"`
	AvatarURL      string `json:"avatar_url"`
	Location       string `json:"location"`
	URL            string `json:"url"`
	VerifiedType   string `json:"verified_type"`
}

type conversationRow struct {
	ID             string   `json:"id"`
	ParticipantIDs []string `json:"participant_ids"`
	Title          string   `json:"title"`
	LastMessageAt  string   `json:"last_message_at"`
	IsGroup        bool     `json:"is_group"`
}

type messageRow struct {
	ID              string `json:"id"`
	ConversationID  string `json:"conversation_id"`
	SenderProfileID string `json:"sender_profile_id"`
	Text            string `json:"text"`
	CreatedAt       string `json:"created_at"`
	Direction       string `json:"direction"`
}

type followEdgeRow struct {
	Direction      string `json:"direction"`
	ProfileID      string `json:"profile_id"`
	ExternalUserID string `json:"external_user_id"`
	Source         string `json:"source"`
	FirstSeenAt    string `json:"first_seen_at"`
	LastSeenAt     string `json:"last_seen_at"`
}

type syncResult struct {
	HelperVersion          string            `json:"helperVersion"`
	ProtocolVersion        int               `json:"protocolVersion"`
	ArchivePath            string            `json:"archivePath"`
	Generation             string            `json:"generation"`
	NextPhase              string            `json:"nextPhase,omitempty"`
	NextRelationshipUserID string            `json:"nextRelationshipUserId,omitempty"`
	NextMessageOffset      int               `json:"nextMessageOffset,omitempty"`
	TotalMessageCount      int               `json:"totalMessageCount"`
	TotalRelationshipCount int               `json:"totalRelationshipCount"`
	Account                accountRow        `json:"account"`
	Profiles               []profileRow      `json:"profiles"`
	Conversations          []conversationRow `json:"conversations"`
	Messages               []messageRow      `json:"messages"`
	FollowEdges            []followEdgeRow   `json:"followEdges"`
	HasMore                bool              `json:"hasMore"`
}

type archiveData struct {
	account             accountRow
	profiles            map[string]profileRow
	conversations       map[string]conversationRow
	messages            []messageRow
	followEdges         []followEdgeRow
	totalMessages       int
	totalRelationships  int
	relationshipHasMore bool
}

func main() {
	if len(os.Args) < 2 {
		fail(errors.New("usage: cued-birdclaw-helper <version|status|sync>"))
	}
	switch os.Args[1] {
	case "version":
		writeJSON(map[string]any{"version": helperVersion, "protocolVersion": protocolVersion})
	case "status":
		runStatus(os.Args[2:])
	case "sync":
		runSync(os.Args[2:])
	default:
		fail(fmt.Errorf("unknown command %q", os.Args[1]))
	}
}

func runStatus(args []string) {
	flags := flag.NewFlagSet("status", flag.ContinueOnError)
	archivePath := flags.String("archive", "", "X archive zip path")
	if err := flags.Parse(args); err != nil {
		fail(err)
	}
	resolved, err := resolveArchivePath(*archivePath)
	if err != nil {
		fail(err)
	}
	reader, err := zip.OpenReader(resolved)
	if err != nil {
		fail(fmt.Errorf("open X archive: %w", err))
	}
	defer reader.Close()
	if findEntry(reader.File, `data/account.js`) == nil {
		fail(errors.New("X archive is missing data/account.js"))
	}
	writeJSON(map[string]any{
		"helperVersion": helperVersion, "protocolVersion": protocolVersion,
		"archivePath": resolved, "available": true,
	})
}

func runSync(args []string) {
	flags := flag.NewFlagSet("sync", flag.ContinueOnError)
	archivePath := flags.String("archive", "", "X archive zip path")
	messageOffset := flags.Int("message-offset", 0, "message cursor offset")
	expectedGeneration := flags.String("generation", "", "archive generation for the cursor")
	phase := flags.String("phase", "messages", "messages or relationships")
	afterRelationshipUserID := flags.String("after-relationship-user-id", "", "exclusive relationship user id cursor")
	knownMessageCount := flags.Int("known-message-count", -1, "known generation message total")
	knownRelationshipCount := flags.Int("known-relationship-count", -1, "known generation relationship total")
	limit := flags.Int("limit", defaultLimit, "maximum messages per page")
	if err := flags.Parse(args); err != nil {
		fail(err)
	}
	if *limit < 1 || *limit > 25000 {
		fail(errors.New("limit must be between 1 and 25000"))
	}
	resolved, err := resolveArchivePath(*archivePath)
	if err != nil {
		fail(err)
	}
	generation, err := archiveGeneration(resolved)
	if err != nil {
		fail(err)
	}
	if *expectedGeneration != "" && *expectedGeneration != generation {
		*messageOffset, *phase, *afterRelationshipUserID = 0, "messages", ""
		*knownMessageCount, *knownRelationshipCount = -1, -1
	}
	data, err := readArchivePage(resolved, *phase, *messageOffset, *afterRelationshipUserID, *knownMessageCount, *knownRelationshipCount, *limit)
	if err != nil {
		fail(err)
	}
	result := syncResult{
		HelperVersion: helperVersion, ProtocolVersion: protocolVersion, ArchivePath: resolved,
		Generation: generation, Account: data.account, Profiles: []profileRow{},
		Conversations: []conversationRow{}, Messages: []messageRow{}, FollowEdges: []followEdgeRow{},
		TotalMessageCount: data.totalMessages, TotalRelationshipCount: data.totalRelationships,
	}
	if *phase == "relationships" {
		result.FollowEdges = data.followEdges
		result.Profiles = profilesForEdges(result.FollowEdges, data.profiles)
		result.HasMore = data.relationshipHasMore
		if result.HasMore {
			result.NextPhase = "relationships"
			if len(data.followEdges) > 0 {
				result.NextRelationshipUserID = data.followEdges[len(data.followEdges)-1].ExternalUserID
			}
		}
	} else {
		filtered := data.messages
		moreMessages := *messageOffset+len(filtered) < data.totalMessages
		result.Messages = filtered
		result.Conversations, result.Profiles = entitiesForMessages(filtered, data)
		result.NextMessageOffset = *messageOffset + len(filtered)
		result.HasMore = moreMessages || data.totalRelationships > 0
		if moreMessages {
			result.NextPhase = "messages"
		} else if data.totalRelationships > 0 {
			result.NextPhase = "relationships"
		}
	}
	writeJSON(result)
}

func entitiesForMessages(messages []messageRow, data archiveData) ([]conversationRow, []profileRow) {
	conversationIDs := make(map[string]bool)
	profileIDs := make(map[string]bool)
	for _, message := range messages {
		conversationIDs[message.ConversationID] = true
		if message.Direction != "outbound" {
			profileIDs[message.SenderProfileID] = true
		}
	}
	conversations := make([]conversationRow, 0, len(conversationIDs))
	for id := range conversationIDs {
		conversation := data.conversations[id]
		conversations = append(conversations, conversation)
		for _, participantID := range conversation.ParticipantIDs {
			profileIDs[profileID(participantID)] = true
		}
	}
	profiles := make([]profileRow, 0, len(profileIDs))
	for id := range profileIDs {
		if profile, exists := data.profiles[id]; exists {
			profiles = append(profiles, profile)
		}
	}
	sort.Slice(conversations, func(i, j int) bool { return conversations[i].ID < conversations[j].ID })
	sort.Slice(profiles, func(i, j int) bool { return profiles[i].ID < profiles[j].ID })
	return conversations, profiles
}

func profilesForEdges(edges []followEdgeRow, profiles map[string]profileRow) []profileRow {
	seen := make(map[string]bool)
	result := make([]profileRow, 0, len(edges))
	for _, edge := range edges {
		if seen[edge.ProfileID] {
			continue
		}
		seen[edge.ProfileID] = true
		result = append(result, profiles[edge.ProfileID])
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}

func archiveGeneration(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%d:%d", info.Size(), info.ModTime().UnixNano()), nil
}

func readArchive(path string) (archiveData, error) {
	return readArchivePage(path, "messages", 0, "", -1, -1, int(^uint(0)>>1))
}

func readArchivePage(path, phase string, messageOffset int, afterRelationshipUserID string, knownMessageCount, knownRelationshipCount, limit int) (archiveData, error) {
	reader, err := zip.OpenReader(path)
	if err != nil {
		return archiveData{}, fmt.Errorf("open X archive: %w", err)
	}
	defer reader.Close()
	result := archiveData{
		profiles: make(map[string]profileRow), conversations: make(map[string]conversationRow),
	}
	accountEntry := findEntry(reader.File, `data/account.js`)
	if accountEntry == nil {
		return archiveData{}, errors.New("X archive is missing data/account.js")
	}
	if err := forEachRecord(accountEntry, func(record map[string]any) error {
		account := asMap(record["account"])
		result.account = accountRow{
			ID: stringValue(account["accountId"]), ExternalUserID: stringValue(account["accountId"]),
			Handle: stringValue(account["username"]),
			Name:   firstNonEmpty(stringValue(account["accountDisplayName"]), stringValue(account["name"]), stringValue(account["username"])),
		}
		return nil
	}); err != nil {
		return archiveData{}, err
	}
	if result.account.ID == "" {
		return archiveData{}, errors.New("X archive account id is missing")
	}
	if phase == "relationships" {
		if knownMessageCount >= 0 {
			result.totalMessages = knownMessageCount
		}
		if err := readRelationshipPage(reader.File, &result, afterRelationshipUserID, limit); err != nil {
			return archiveData{}, err
		}
	} else {
		for _, file := range reader.File {
			if dmEntryPattern.MatchString(normalizePath(file.Name)) {
				if err := parseDMEntry(file, &result, messageOffset, limit); err != nil {
					return archiveData{}, err
				}
			}
		}
		if knownRelationshipCount >= 0 {
			result.totalRelationships = knownRelationshipCount
		} else {
			count, err := countRelationshipEdges(reader.File)
			if err != nil {
				return archiveData{}, err
			}
			result.totalRelationships = count
		}
	}
	enrichProfilesFromMentions(reader.File, result.profiles)
	return result, nil
}

func parseDMEntry(file *zip.File, result *archiveData, messageOffset, messageLimit int) error {
	reader, decoder, err := archiveArrayDecoder(file)
	if err != nil {
		return err
	}
	defer reader.Close()
	for decoder.More() {
		if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
			return fmt.Errorf("read %s record: %w", file.Name, err)
		}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			if keyToken != "dmConversation" {
				var ignored any
				if err := decoder.Decode(&ignored); err != nil {
					return err
				}
				continue
			}
			if err := parseDMConversation(decoder, result, messageOffset, messageLimit); err != nil {
				return err
			}
		}
		if _, err := decoder.Token(); err != nil {
			return err
		}
	}
	return nil
}

func parseDMConversation(decoder *json.Decoder, result *archiveData, messageOffset, messageLimit int) error {
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return fmt.Errorf("read dmConversation: %w", err)
	}
	conversationID, name := "", ""
	membership := map[string]bool{}
	knownMembership := map[string]bool{}
	selected := []messageRow{}
	lastMessageAt := ""
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return err
		}
		key := keyToken.(string)
		switch key {
		case "conversationId":
			if err := decoder.Decode(&conversationID); err != nil {
				return err
			}
		case "name":
			if err := decoder.Decode(&name); err != nil {
				return err
			}
		case "messages":
			if token, err := decoder.Token(); err != nil || token != json.Delim('[') {
				return err
			}
			for decoder.More() {
				var event map[string]any
				if err := decoder.Decode(&event); err != nil {
					return err
				}
				applyMembershipEvent(event, membership, knownMembership)
				messageCreate := asMap(event["messageCreate"])
				if len(messageCreate) == 0 {
					continue
				}
				messageIndex := result.totalMessages
				result.totalMessages++
				if messageIndex < messageOffset || len(result.messages)+len(selected) >= messageLimit {
					continue
				}
				senderID := stringValue(messageCreate["senderId"])
				createdAt := parseTwitterDate(stringValue(messageCreate["createdAt"]))
				direction := "inbound"
				if senderID == result.account.ExternalUserID {
					direction = "outbound"
				}
				selected = append(selected, messageRow{ID: firstNonEmpty(stringValue(messageCreate["id"]), "message-"+strconv.Itoa(messageIndex)), SenderProfileID: profileID(senderID), Text: stringValue(messageCreate["text"]), CreatedAt: createdAt, Direction: direction})
				if createdAt > lastMessageAt {
					lastMessageAt = createdAt
				}
			}
			if _, err := decoder.Token(); err != nil {
				return err
			}
		default:
			var ignored any
			if err := decoder.Decode(&ignored); err != nil {
				return err
			}
		}
	}
	if _, err := decoder.Token(); err != nil {
		return err
	}
	if conversationID == "" || len(selected) == 0 {
		return nil
	}
	participants := []string{}
	for userID, active := range membership {
		if active && userID != "" && userID != result.account.ExternalUserID {
			participants = append(participants, userID)
			ensureProfile(result, userID)
		}
	}
	sort.Strings(participants)
	for index := range selected {
		selected[index].ConversationID = conversationID
		if strings.HasPrefix(selected[index].ID, "message-") {
			selected[index].ID = conversationID + "-" + selected[index].ID
		}
		if selected[index].Direction != "outbound" {
			ensureProfile(result, strings.TrimPrefix(selected[index].SenderProfileID, "profile_user_"))
		}
	}
	result.messages = append(result.messages, selected...)
	result.conversations[conversationID] = conversationRow{ID: conversationID, ParticipantIDs: participants, Title: firstNonEmpty(name, conversationTitle(participants, result.profiles)), LastMessageAt: lastMessageAt, IsGroup: len(participants) > 1 || name != ""}
	return nil
}

func applyMembershipEvent(event map[string]any, membership, known map[string]bool) {
	// X stores DM events newest-first, so the first membership fact for a user is current.
	setIfUnknown := func(userID string, active bool) {
		if userID == "" || known[userID] {
			return
		}
		known[userID], membership[userID] = true, active
	}
	if payload := asMap(event["participantsLeave"]); len(payload) > 0 {
		userIDs := asSlice(payload["userIds"])
		for _, value := range userIDs {
			setIfUnknown(stringValue(value), false)
		}
		if len(userIDs) == 0 {
			setIfUnknown(stringValue(payload["initiatingUserId"]), false)
		}
	}
	if payload := asMap(event["participantsJoin"]); len(payload) > 0 {
		for _, value := range asSlice(payload["userIds"]) {
			setIfUnknown(stringValue(value), true)
		}
		setIfUnknown(stringValue(payload["initiatingUserId"]), true)
	}
	if payload := asMap(event["joinConversation"]); len(payload) > 0 {
		for _, value := range asSlice(payload["participantsSnapshot"]) {
			setIfUnknown(stringValue(value), true)
		}
	}
	if payload := asMap(event["messageCreate"]); len(payload) > 0 {
		setIfUnknown(stringValue(payload["senderId"]), true)
		setIfUnknown(stringValue(payload["recipientId"]), true)
	}
}

type userIDMaxHeap []string

func (items userIDMaxHeap) Len() int           { return len(items) }
func (items userIDMaxHeap) Less(i, j int) bool { return items[i] > items[j] }
func (items userIDMaxHeap) Swap(i, j int)      { items[i], items[j] = items[j], items[i] }
func (items *userIDMaxHeap) Push(value any)    { *items = append(*items, value.(string)) }
func (items *userIDMaxHeap) Pop() any {
	old := *items
	last := old[len(old)-1]
	*items = old[:len(old)-1]
	return last
}

var followInputs = []struct {
	pattern        *regexp.Regexp
	direction, key string
}{
	{followerEntryPattern, "followers", "follower"},
	{followingEntryPattern, "following", "following"},
}

func scanFollowRecords(files []*zip.File, visit func(direction, userID string)) error {
	for _, input := range followInputs {
		for _, file := range files {
			if !input.pattern.MatchString(normalizePath(file.Name)) {
				continue
			}
			if err := forEachRecord(file, func(record map[string]any) error {
				userID := stringValue(asMap(record[input.key])["accountId"])
				if userID != "" {
					visit(input.direction, userID)
				}
				return nil
			}); err != nil {
				return err
			}
		}
	}
	return nil
}

func countRelationshipEdges(files []*zip.File) (int, error) {
	count := 0
	err := scanFollowRecords(files, func(_, _ string) { count++ })
	return count, err
}

func readRelationshipPage(files []*zip.File, result *archiveData, afterUserID string, limit int) error {
	candidates := &userIDMaxHeap{}
	heap.Init(candidates)
	selected := map[string]bool{}
	total := 0
	if err := scanFollowRecords(files, func(_ string, userID string) {
		total++
		if userID <= afterUserID || selected[userID] {
			return
		}
		if candidates.Len() < limit {
			heap.Push(candidates, userID)
			selected[userID] = true
			return
		}
		if userID >= (*candidates)[0] {
			return
		}
		delete(selected, heap.Pop(candidates).(string))
		heap.Push(candidates, userID)
		selected[userID] = true
	}); err != nil {
		return err
	}
	userIDs := make([]string, 0, len(selected))
	for userID := range selected {
		userIDs = append(userIDs, userID)
	}
	sort.Strings(userIDs)
	directions := map[string]map[string]bool{}
	if err := scanFollowRecords(files, func(direction, userID string) {
		if !selected[userID] {
			return
		}
		if directions[userID] == nil {
			directions[userID] = map[string]bool{}
		}
		directions[userID][direction] = true
	}); err != nil {
		return err
	}
	for _, userID := range userIDs {
		ensureProfile(result, userID)
		for _, direction := range []string{"followers", "following"} {
			if directions[userID][direction] {
				result.followEdges = append(result.followEdges, followEdgeRow{Direction: direction, ProfileID: profileID(userID), ExternalUserID: userID, Source: "archive"})
			}
		}
	}
	result.totalRelationships = total
	if len(userIDs) > 0 {
		last := userIDs[len(userIDs)-1]
		if err := scanFollowRecords(files, func(_ string, userID string) {
			if userID > last {
				result.relationshipHasMore = true
			}
		}); err != nil {
			return err
		}
	}
	return nil
}

func enrichProfilesFromMentions(files []*zip.File, profiles map[string]profileRow) {
	for _, file := range files {
		if !tweetEntryPattern.MatchString(normalizePath(file.Name)) {
			continue
		}
		_ = forEachRecord(file, func(record map[string]any) error {
			tweet := asMap(record["tweet"])
			entities := asMap(tweet["entities"])
			for _, rawMention := range asSlice(entities["user_mentions"]) {
				mention := asMap(rawMention)
				userID := firstNonEmpty(stringValue(mention["id_str"]), stringValue(mention["id"]))
				id := profileID(userID)
				if _, wanted := profiles[id]; wanted {
					handle := stringValue(mention["screen_name"])
					profiles[id] = profileRow{
						ID: id, Handle: handle,
						DisplayName: firstNonEmpty(stringValue(mention["name"]), handle, "X user "+userID),
					}
				}
			}
			return nil
		})
	}
}

func ensureProfile(result *archiveData, userID string) {
	id := profileID(userID)
	if _, exists := result.profiles[id]; exists {
		return
	}
	result.profiles[id] = profileRow{ID: id, DisplayName: "X user " + userID}
}

func archiveArrayDecoder(file *zip.File) (io.ReadCloser, *json.Decoder, error) {
	reader, err := file.Open()
	if err != nil {
		return nil, nil, err
	}
	buffered := bufio.NewReader(reader)
	if _, err := buffered.ReadString('='); err != nil {
		reader.Close()
		return nil, nil, fmt.Errorf("read %s assignment: %w", file.Name, err)
	}
	decoder := json.NewDecoder(buffered)
	if token, err := decoder.Token(); err != nil || token != json.Delim('[') {
		reader.Close()
		return nil, nil, fmt.Errorf("read %s array: %w", file.Name, err)
	}
	return reader, decoder, nil
}

func forEachRecord(file *zip.File, visit func(map[string]any) error) error {
	reader, err := file.Open()
	if err != nil {
		return err
	}
	defer reader.Close()
	buffered := bufio.NewReader(reader)
	if _, err := buffered.ReadString('='); err != nil {
		return fmt.Errorf("read %s assignment: %w", file.Name, err)
	}
	decoder := json.NewDecoder(buffered)
	token, err := decoder.Token()
	if err != nil || token != json.Delim('[') {
		return fmt.Errorf("read %s array: %w", file.Name, err)
	}
	for decoder.More() {
		var record map[string]any
		if err := decoder.Decode(&record); err != nil {
			return fmt.Errorf("decode %s: %w", file.Name, err)
		}
		if err := visit(record); err != nil {
			return err
		}
	}
	return nil
}

func findEntry(files []*zip.File, suffix string) *zip.File {
	suffix = strings.ToLower(suffix)
	for _, file := range files {
		if strings.HasSuffix(strings.ToLower(normalizePath(file.Name)), suffix) {
			return file
		}
	}
	return nil
}

func resolveArchivePath(value string) (string, error) {
	path := strings.TrimSpace(value)
	if path == "" {
		return "", errors.New("X archive path is required")
	}
	if strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		path = filepath.Join(home, strings.TrimPrefix(path, "~/"))
	}
	return filepath.Abs(path)
}

func parseTwitterDate(value string) string {
	for _, layout := range []string{time.RFC3339Nano, "Mon Jan 02 15:04:05 -0700 2006"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.UTC().Format(time.RFC3339Nano)
		}
	}
	return value
}

func profileID(userID string) string    { return "profile_user_" + userID }
func normalizePath(value string) string { return strings.ReplaceAll(value, `\`, "/") }

func conversationTitle(participants []string, profiles map[string]profileRow) string {
	names := make([]string, 0, len(participants))
	for _, userID := range participants {
		names = append(names, profiles[profileID(userID)].DisplayName)
	}
	return strings.Join(names, ", ")
}

func asMap(value any) map[string]any {
	if result, ok := value.(map[string]any); ok {
		return result
	}
	return map[string]any{}
}

func asSlice(value any) []any {
	if result, ok := value.([]any); ok {
		return result
	}
	return nil
}

func stringValue(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case json.Number:
		return typed.String()
	case float64:
		return strconv.FormatInt(int64(typed), 10)
	default:
		return ""
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func writeJSON(value any) {
	if err := json.NewEncoder(os.Stdout).Encode(value); err != nil {
		fail(err)
	}
}

func fail(err error) {
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": false, "error": err.Error()})
	os.Exit(1)
}
