package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"strings"
	"time"

	slackapi "github.com/slack-go/slack"
)

const (
	defaultSessionPollInterval = 15 * time.Second
	defaultSessionUserRefresh  = 5 * time.Minute
	defaultSessionPageLimit    = 100
)

type sessionRequest struct {
	Credentials       slackCredentials `json:"credentials"`
	PollIntervalMs    int              `json:"pollIntervalMs"`
	UserRefreshMs     int              `json:"userRefreshMs"`
	ConversationLimit int              `json:"conversationLimit"`
	MessageLimit      int              `json:"messageLimit"`
}

type sessionEventEnvelope struct {
	Event string `json:"event"`
	Data  any    `json:"data,omitempty"`
}

type connectedEventData struct {
	TeamID    string `json:"teamId"`
	UserID    string `json:"userId"`
	Transport string `json:"transport"`
}

type disconnectedEventData struct {
	Reason string `json:"reason"`
}

type contactUpsertEventData struct {
	TeamID string    `json:"teamId"`
	User   slackUser `json:"user"`
}

type conversationUpsertEventData struct {
	TeamID       string            `json:"teamId"`
	SelfUserID   string            `json:"selfUserId"`
	Conversation slackConversation `json:"conversation"`
	MemberIDs    []string          `json:"memberIds"`
	DisplayName  string            `json:"displayName"`
	IsNew        bool              `json:"isNew"`
}

type messageUpsertEventData struct {
	TeamID         string       `json:"teamId"`
	SelfUserID     string       `json:"selfUserId"`
	ConversationID string       `json:"conversationId"`
	Message        slackMessage `json:"message"`
}

type sessionState struct {
	conversationVersions map[string]string
	messageWatermarks    map[string]string
	userVersions         map[string]string
}

func sessionPositiveDuration(valueMs int, fallback time.Duration) time.Duration {
	if valueMs > 0 {
		return time.Duration(valueMs) * time.Millisecond
	}
	return fallback
}

func sessionPositiveInt(value int, fallback int) int {
	if value > 0 {
		return value
	}
	return fallback
}

func slackTSAfter(left, right string) bool {
	if strings.TrimSpace(right) == "" {
		return strings.TrimSpace(left) != ""
	}
	if leftFloat, err := parseSlackFloat(left); err == nil {
		if rightFloat, err := parseSlackFloat(right); err == nil {
			return leftFloat > rightFloat
		}
	}
	return left > right
}

func messageHasContent(message slackapi.Message) bool {
	return message.Text != "" || len(message.Files) > 0 || len(message.Attachments) > 0
}

func shouldEmitRealtimeMessage(message slackapi.Message) bool {
	if message.SubType == "channel_join" || message.SubType == "channel_leave" {
		return false
	}
	return messageHasContent(message)
}

func parseSlackFloat(value string) (float64, error) {
	return json.Number(value).Float64()
}

func sortSlackMessages(messages []slackMessage) {
	slices.SortFunc(messages, func(left, right slackMessage) int {
		leftValue, leftErr := parseSlackFloat(left.TS)
		rightValue, rightErr := parseSlackFloat(right.TS)
		if leftErr == nil && rightErr == nil {
			switch {
			case leftValue < rightValue:
				return -1
			case leftValue > rightValue:
				return 1
			default:
				return 0
			}
		}
		return strings.Compare(left.TS, right.TS)
	})
}

func conversationDisplayName(conversation slackConversation, usersByID map[string]slackUser) string {
	if conversation.IsIM && conversation.User != "" {
		if user, ok := usersByID[conversation.User]; ok {
			switch {
			case user.RealName != "":
				return user.RealName
			case user.Profile.RealName != "":
				return user.Profile.RealName
			case user.Profile.DisplayName != "":
				return user.Profile.DisplayName
			case user.Name != "":
				return user.Name
			}
		}
		return conversation.User
	}
	switch {
	case conversation.Name != "":
		return conversation.Name
	case conversation.Topic != nil && conversation.Topic.Value != "":
		return conversation.Topic.Value
	case conversation.Purpose != nil && conversation.Purpose.Value != "":
		return conversation.Purpose.Value
	default:
		return conversation.ID
	}
}

func conversationVersionKey(conversation slackConversation, memberIDs []string, displayName string) string {
	latestTS := ""
	if conversation.Latest != nil {
		latestTS = conversation.Latest.TS
	}
	return strings.Join([]string{
		latestTS,
		displayName,
		conversation.Name,
		conversation.User,
		fmt.Sprintf("%d", len(memberIDs)),
	}, "|")
}

func userVersionKey(user slackUser) string {
	return strings.Join([]string{
		user.RealName,
		user.Profile.RealName,
		user.Profile.DisplayName,
		user.Profile.Email,
		user.Profile.Image72,
		user.Profile.Image192,
		user.Profile.Image512,
		user.Profile.ImageOriginal,
	}, "|")
}

func writeSessionEvent(writer io.Writer, event string, data any) error {
	return writeJSON(writer, sessionEventEnvelope{
		Event: event,
		Data:  data,
	})
}

func listAllUsersForSession(ctx context.Context, client *slackapi.Client) ([]slackUser, error) {
	pagination := client.GetUsersPaginated(slackapi.GetUsersOptionLimit(defaultSessionPageLimit))
	users := make([]slackUser, 0)
	for {
		page, nextErr := pagination.Next(ctx)
		if nextErr != nil {
			return nil, nextErr
		}
		for _, user := range page.Users {
			if user.Deleted {
				continue
			}
			users = append(users, toSlackUser(user))
		}
		if page.Cursor == "" {
			break
		}
		pagination = client.GetUsersPaginated(
			slackapi.GetUsersOptionCursor(page.Cursor),
			slackapi.GetUsersOptionLimit(defaultSessionPageLimit),
		)
	}
	return users, nil
}

func listAllConversationsForSession(
	ctx context.Context,
	client *slackapi.Client,
	types []string,
	limit int,
) ([]slackConversation, error) {
	cursor := ""
	conversations := make([]slackConversation, 0)
	for {
		channels, nextCursor, err := client.GetConversationsForUserContext(ctx, &slackapi.GetConversationsForUserParameters{
			Types:  types,
			Cursor: cursor,
			Limit:  limit,
		})
		if err != nil {
			return nil, err
		}
		for _, channel := range channels {
			conversations = append(conversations, toSlackConversation(channel))
		}
		if nextCursor == "" {
			return conversations, nil
		}
		cursor = nextCursor
	}
}

func listConversationMembersForSession(
	ctx context.Context,
	client *slackapi.Client,
	conversation slackConversation,
) ([]string, error) {
	if conversation.IsIM && conversation.User != "" {
		return []string{conversation.User}, nil
	}
	cursor := ""
	members := make([]string, 0)
	for {
		page, nextCursor, err := client.GetUsersInConversationContext(ctx, &slackapi.GetUsersInConversationParameters{
			ChannelID: conversation.ID,
			Cursor:    cursor,
			Limit:     defaultSessionPageLimit,
		})
		if err != nil {
			return nil, err
		}
		members = append(members, page...)
		if nextCursor == "" {
			slices.Sort(members)
			return slices.Compact(members), nil
		}
		cursor = nextCursor
	}
}

func collectConversationDelta(
	ctx context.Context,
	client *slackapi.Client,
	conversationID string,
	oldest string,
	limit int,
) ([]slackMessage, error) {
	messageByTS := make(map[string]slackMessage)
	threadParents := make([]string, 0)
	cursor := ""

	for {
		history, err := client.GetConversationHistoryContext(ctx, &slackapi.GetConversationHistoryParameters{
			ChannelID: conversationID,
			Cursor:    cursor,
			Oldest:    oldest,
			Limit:     limit,
		})
		if err != nil {
			return nil, err
		}
		for _, message := range history.Messages {
			if message.ReplyCount > 0 {
				threadParents = append(threadParents, message.Timestamp)
			}
			if !shouldEmitRealtimeMessage(message) {
				continue
			}
			messageByTS[message.Timestamp] = toSlackMessage(message)
		}
		cursor = history.ResponseMetaData.NextCursor
		if cursor == "" {
			break
		}
	}

	for _, threadTS := range threadParents {
		repliesCursor := ""
		for {
			replies, hasMore, nextCursor, err := client.GetConversationRepliesContext(ctx, &slackapi.GetConversationRepliesParameters{
				ChannelID: conversationID,
				Timestamp: threadTS,
				Cursor:    repliesCursor,
				Oldest:    oldest,
				Limit:     limit,
			})
			if err != nil {
				return nil, err
			}
			for _, reply := range replies {
				if reply.Timestamp == threadTS || !shouldEmitRealtimeMessage(reply) {
					continue
				}
				messageByTS[reply.Timestamp] = toSlackMessage(reply)
			}
			repliesCursor = nextCursor
			if !hasMore || repliesCursor == "" {
				break
			}
		}
	}

	messages := make([]slackMessage, 0, len(messageByTS))
	for _, message := range messageByTS {
		messages = append(messages, message)
	}
	sortSlackMessages(messages)
	return messages, nil
}

func (r helperRunner) runSession(ctx context.Context, stdin io.Reader, stdout io.Writer) error {
	input, err := decodeRequest[sessionRequest](stdin)
	if err != nil {
		return err
	}
	client, err := newSlackClient(input.Credentials, r.apiURL)
	if err != nil {
		return err
	}
	auth, err := client.AuthTestContext(ctx)
	if err != nil {
		return err
	}

	state := sessionState{
		conversationVersions: make(map[string]string),
		messageWatermarks:    make(map[string]string),
		userVersions:         make(map[string]string),
	}
	usersByID := make(map[string]slackUser)
	pollInterval := sessionPositiveDuration(input.PollIntervalMs, defaultSessionPollInterval)
	userRefreshInterval := sessionPositiveDuration(input.UserRefreshMs, defaultSessionUserRefresh)
	conversationLimit := sessionPositiveInt(input.ConversationLimit, defaultSessionPageLimit)
	messageLimit := sessionPositiveInt(input.MessageLimit, defaultSessionPageLimit)
	lastUserRefresh := time.Time{}

	if err := writeSessionEvent(stdout, "connected", connectedEventData{
		TeamID:    auth.TeamID,
		UserID:    auth.UserID,
		Transport: "polling",
	}); err != nil {
		return err
	}

	refreshUsers := func(force bool) error {
		if !force && !lastUserRefresh.IsZero() && time.Since(lastUserRefresh) < userRefreshInterval {
			return nil
		}
		users, refreshErr := listAllUsersForSession(ctx, client)
		if refreshErr != nil {
			return refreshErr
		}
		lastUserRefresh = time.Now()
		for _, user := range users {
			usersByID[user.ID] = user
			version := userVersionKey(user)
			if state.userVersions[user.ID] == version {
				continue
			}
			state.userVersions[user.ID] = version
			if eventErr := writeSessionEvent(stdout, "contact_upsert", contactUpsertEventData{
				TeamID: auth.TeamID,
				User:   user,
			}); eventErr != nil {
				return eventErr
			}
		}
		return nil
	}

	if err := refreshUsers(true); err != nil {
		return err
	}

	for {
		select {
		case <-ctx.Done():
			return nil
		default:
		}

		if err := refreshUsers(false); err != nil {
			_ = writeSessionEvent(stdout, "disconnected", disconnectedEventData{Reason: err.Error()})
			return err
		}

		for _, types := range [][]string{{"im", "mpim"}, {"public_channel", "private_channel"}} {
			conversations, listErr := listAllConversationsForSession(ctx, client, types, conversationLimit)
			if listErr != nil {
				_ = writeSessionEvent(stdout, "disconnected", disconnectedEventData{Reason: listErr.Error()})
				return listErr
			}

			for _, conversation := range conversations {
				memberIDs := make([]string, 0)
				isNewConversation := state.conversationVersions[conversation.ID] == ""
				if conversation.IsIM {
					if conversation.User != "" {
						memberIDs = []string{conversation.User}
					}
				} else if conversation.IsMPIM || isNewConversation {
					memberIDs, err = listConversationMembersForSession(ctx, client, conversation)
					if err != nil {
						_ = writeSessionEvent(stdout, "disconnected", disconnectedEventData{Reason: err.Error()})
						return err
					}
				}

				displayName := conversationDisplayName(conversation, usersByID)
				version := conversationVersionKey(conversation, memberIDs, displayName)
				if state.conversationVersions[conversation.ID] != version {
					state.conversationVersions[conversation.ID] = version
					if eventErr := writeSessionEvent(stdout, "conversation_upsert", conversationUpsertEventData{
						TeamID:       auth.TeamID,
						SelfUserID:   auth.UserID,
						Conversation: conversation,
						MemberIDs:    memberIDs,
						DisplayName:  displayName,
						IsNew:        isNewConversation,
					}); eventErr != nil {
						return eventErr
					}
				}

				previousWatermark := state.messageWatermarks[conversation.ID]
				if isNewConversation {
					if conversation.Latest != nil {
						state.messageWatermarks[conversation.ID] = conversation.Latest.TS
					}
					continue
				}

				messages, historyErr := collectConversationDelta(
					ctx,
					client,
					conversation.ID,
					previousWatermark,
					messageLimit,
				)
				if historyErr != nil {
					_ = writeSessionEvent(stdout, "disconnected", disconnectedEventData{Reason: historyErr.Error()})
					return historyErr
				}
				for _, message := range messages {
					if !slackTSAfter(message.TS, previousWatermark) {
						continue
					}
					if eventErr := writeSessionEvent(stdout, "message_upsert", messageUpsertEventData{
						TeamID:         auth.TeamID,
						SelfUserID:     auth.UserID,
						ConversationID: conversation.ID,
						Message:        message,
					}); eventErr != nil {
						return eventErr
					}
					if slackTSAfter(message.TS, state.messageWatermarks[conversation.ID]) {
						state.messageWatermarks[conversation.ID] = message.TS
					}
				}
				if conversation.Latest != nil && slackTSAfter(conversation.Latest.TS, state.messageWatermarks[conversation.ID]) {
					state.messageWatermarks[conversation.ID] = conversation.Latest.TS
				}
			}
		}

		timer := time.NewTimer(pollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
	}
}
