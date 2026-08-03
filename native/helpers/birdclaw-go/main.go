package main

import (
	"archive/zip"
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
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
	NextEdgeOffset         int               `json:"nextEdgeOffset,omitempty"`
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
	account       accountRow
	profiles      map[string]profileRow
	conversations map[string]conversationRow
	messages      []messageRow
	followEdges   []followEdgeRow
	totalMessages int
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
	edgeOffset := flags.Int("edge-offset", 0, "relationship cursor offset")
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
		*messageOffset, *phase, *edgeOffset = 0, "messages", 0
	}
	data, err := readArchivePage(resolved, *messageOffset, *limit)
	if err != nil {
		fail(err)
	}
	result := syncResult{
		HelperVersion: helperVersion, ProtocolVersion: protocolVersion, ArchivePath: resolved,
		Generation: generation, Account: data.account, Profiles: []profileRow{},
		Conversations: []conversationRow{}, Messages: []messageRow{}, FollowEdges: []followEdgeRow{},
		TotalMessageCount: data.totalMessages, TotalRelationshipCount: len(data.followEdges),
	}
	if *phase == "relationships" {
		start := max(0, *edgeOffset)
		if start > len(data.followEdges) {
			start = len(data.followEdges)
		}
		end := min(start+*limit, len(data.followEdges))
		for end < len(data.followEdges) && end > start &&
			data.followEdges[end].ProfileID == data.followEdges[end-1].ProfileID {
			end++
		}
		result.FollowEdges = data.followEdges[start:end]
		result.Profiles = profilesForEdges(result.FollowEdges, data.profiles)
		result.HasMore = end < len(data.followEdges)
		if result.HasMore {
			result.NextPhase = "relationships"
			result.NextEdgeOffset = end
		}
	} else {
		filtered := data.messages
		moreMessages := *messageOffset+len(filtered) < data.totalMessages
		result.Messages = filtered
		result.Conversations, result.Profiles = entitiesForMessages(filtered, data)
		result.NextMessageOffset = *messageOffset + len(filtered)
		result.HasMore = moreMessages || len(data.followEdges) > 0
		if moreMessages {
			result.NextPhase = "messages"
		} else if len(data.followEdges) > 0 {
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
	return readArchivePage(path, 0, int(^uint(0)>>1))
}

func readArchivePage(path string, messageOffset, messageLimit int) (archiveData, error) {
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
	mentionDirectory := readMentionDirectory(reader.File)
	for _, file := range reader.File {
		if dmEntryPattern.MatchString(normalizePath(file.Name)) {
			if err := parseDMEntry(file, &result, mentionDirectory, messageOffset, messageLimit); err != nil {
				return archiveData{}, err
			}
		}
	}
	for _, input := range []struct {
		pattern   *regexp.Regexp
		direction string
		key       string
	}{{followerEntryPattern, "followers", "follower"}, {followingEntryPattern, "following", "following"}} {
		for _, file := range reader.File {
			if input.pattern.MatchString(normalizePath(file.Name)) {
				if err := parseFollowEntry(file, &result, mentionDirectory, input.direction, input.key); err != nil {
					return archiveData{}, err
				}
			}
		}
	}
	sort.Slice(result.followEdges, func(i, j int) bool {
		if result.followEdges[i].ProfileID == result.followEdges[j].ProfileID {
			return result.followEdges[i].Direction < result.followEdges[j].Direction
		}
		return result.followEdges[i].ProfileID < result.followEdges[j].ProfileID
	})
	return result, nil
}

func parseDMEntry(file *zip.File, result *archiveData, directory map[string]profileRow, messageOffset, messageLimit int) error {
	return forEachRecord(file, func(record map[string]any) error {
		conversation := asMap(record["dmConversation"])
		conversationID := stringValue(conversation["conversationId"])
		if conversationID == "" {
			return nil
		}
		participantSet := make(map[string]bool)
		messages := asSlice(conversation["messages"])
		lastMessageAt := ""
		selectedConversation := false
		for _, rawEvent := range messages {
			event := asMap(rawEvent)
			messageCreate := asMap(event["messageCreate"])
			if len(messageCreate) == 0 {
				for _, userID := range participantIDs(event) {
					participantSet[userID] = true
				}
				continue
			}
			senderID := stringValue(messageCreate["senderId"])
			recipientID := stringValue(messageCreate["recipientId"])
			if senderID != "" {
				participantSet[senderID] = true
			}
			if recipientID != "" {
				participantSet[recipientID] = true
			}
			messageIndex := result.totalMessages
			result.totalMessages++
			if messageIndex < messageOffset || len(result.messages) >= messageLimit {
				continue
			}
			selectedConversation = true
			messageID := firstNonEmpty(stringValue(messageCreate["id"]), conversationID+"-"+senderID+"-"+strconv.Itoa(messageIndex))
			createdAt := parseTwitterDate(stringValue(messageCreate["createdAt"]))
			direction := "inbound"
			if senderID == result.account.ExternalUserID {
				direction = "outbound"
			} else if senderID != "" {
				ensureProfile(result, directory, senderID)
			}
			result.messages = append(result.messages, messageRow{
				ID: messageID, ConversationID: conversationID, SenderProfileID: profileID(senderID),
				Text: stringValue(messageCreate["text"]), CreatedAt: createdAt, Direction: direction,
			})
			if createdAt > lastMessageAt {
				lastMessageAt = createdAt
			}
		}
		participants := make([]string, 0, len(participantSet))
		for userID := range participantSet {
			if userID != "" && userID != result.account.ExternalUserID {
				participants = append(participants, userID)
				ensureProfile(result, directory, userID)
			}
		}
		sort.Strings(participants)
		if selectedConversation {
			result.conversations[conversationID] = conversationRow{
				ID: conversationID, ParticipantIDs: participants,
				Title:         firstNonEmpty(stringValue(conversation["name"]), conversationTitle(participants, result.profiles)),
				LastMessageAt: lastMessageAt, IsGroup: len(participants) > 1 || stringValue(conversation["name"]) != "",
			}
		}
		return nil
	})
}

func participantIDs(event map[string]any) []string {
	result := []string{}
	for _, input := range []struct {
		key  string
		list string
	}{{"joinConversation", "participantsSnapshot"}, {"participantsJoin", "userIds"}, {"participantsLeave", "userIds"}} {
		payload := asMap(event[input.key])
		for _, value := range asSlice(payload[input.list]) {
			if userID := stringValue(value); userID != "" {
				result = append(result, userID)
			}
		}
		if userID := stringValue(payload["initiatingUserId"]); userID != "" {
			result = append(result, userID)
		}
	}
	return result
}

func parseFollowEntry(file *zip.File, result *archiveData, directory map[string]profileRow, direction, key string) error {
	return forEachRecord(file, func(record map[string]any) error {
		item := asMap(record[key])
		userID := stringValue(item["accountId"])
		if userID == "" {
			return nil
		}
		ensureProfile(result, directory, userID)
		result.followEdges = append(result.followEdges, followEdgeRow{
			Direction: direction, ProfileID: profileID(userID), ExternalUserID: userID, Source: "archive",
		})
		return nil
	})
}

func readMentionDirectory(files []*zip.File) map[string]profileRow {
	directory := make(map[string]profileRow)
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
				if userID != "" {
					handle := stringValue(mention["screen_name"])
					directory[userID] = profileRow{
						ID: profileID(userID), Handle: handle,
						DisplayName: firstNonEmpty(stringValue(mention["name"]), handle, "X user "+userID),
					}
				}
			}
			return nil
		})
	}
	return directory
}

func ensureProfile(result *archiveData, directory map[string]profileRow, userID string) {
	id := profileID(userID)
	if _, exists := result.profiles[id]; exists {
		return
	}
	profile, exists := directory[userID]
	if !exists {
		profile = profileRow{ID: id, DisplayName: "X user " + userID}
	}
	result.profiles[id] = profile
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
