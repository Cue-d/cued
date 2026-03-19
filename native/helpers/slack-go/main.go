package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	slackapi "github.com/slack-go/slack"
)

const (
	helperVersion   = "0.1.0"
	protocolVersion = 1
	requestTimeout  = 2 * time.Minute
)

type slackCredentials struct {
	Token  string `json:"token"`
	Cookie string `json:"cookie"`
}

type authTestRequest struct {
	Credentials slackCredentials `json:"credentials"`
}

type listUsersRequest struct {
	Credentials slackCredentials `json:"credentials"`
	Cursor      string           `json:"cursor"`
	Limit       int              `json:"limit"`
}

type listConversationsRequest struct {
	Credentials slackCredentials `json:"credentials"`
	Types       string           `json:"types"`
	Cursor      string           `json:"cursor"`
	Limit       int              `json:"limit"`
}

type conversationMembersRequest struct {
	Credentials slackCredentials `json:"credentials"`
	Channel     string           `json:"channel"`
	Cursor      string           `json:"cursor"`
	Limit       int              `json:"limit"`
}

type historyRequest struct {
	Credentials slackCredentials `json:"credentials"`
	Channel     string           `json:"channel"`
	Cursor      string           `json:"cursor"`
	Oldest      string           `json:"oldest"`
	Limit       int              `json:"limit"`
}

type repliesRequest struct {
	Credentials slackCredentials `json:"credentials"`
	Channel     string           `json:"channel"`
	ThreadTS    string           `json:"threadTs"`
	Cursor      string           `json:"cursor"`
	Oldest      string           `json:"oldest"`
	Limit       int              `json:"limit"`
}

type commandEnvelope struct {
	OK              bool   `json:"ok"`
	ProtocolVersion int    `json:"protocolVersion"`
	Error           string `json:"error,omitempty"`
	Result          any    `json:"result,omitempty"`
}

type versionResult struct {
	Version         string `json:"version"`
	ProtocolVersion int    `json:"protocolVersion"`
}

type statusResult struct {
	HelperVersion   string `json:"helperVersion"`
	ProtocolVersion int    `json:"protocolVersion"`
}

type slackAuthTestResponse struct {
	OK     bool   `json:"ok"`
	Error  string `json:"error,omitempty"`
	Team   string `json:"team,omitempty"`
	User   string `json:"user,omitempty"`
	TeamID string `json:"team_id,omitempty"`
	UserID string `json:"user_id,omitempty"`
}

type slackUserProfile struct {
	RealName      string `json:"real_name,omitempty"`
	DisplayName   string `json:"display_name,omitempty"`
	Email         string `json:"email,omitempty"`
	Image72       string `json:"image_72,omitempty"`
	Image192      string `json:"image_192,omitempty"`
	Image512      string `json:"image_512,omitempty"`
	ImageOriginal string `json:"image_original,omitempty"`
}

type slackUser struct {
	ID       string           `json:"id"`
	TeamID   string           `json:"team_id,omitempty"`
	Name     string           `json:"name,omitempty"`
	RealName string           `json:"real_name,omitempty"`
	Deleted  bool             `json:"deleted,omitempty"`
	Profile  slackUserProfile `json:"profile"`
}

type slackReaction struct {
	Name  string   `json:"name"`
	Count int      `json:"count"`
	Users []string `json:"users"`
}

type slackFile struct {
	ID                 string `json:"id"`
	Name               string `json:"name,omitempty"`
	Mimetype           string `json:"mimetype,omitempty"`
	PrettyType         string `json:"pretty_type,omitempty"`
	Size               int    `json:"size,omitempty"`
	URLPrivate         string `json:"url_private,omitempty"`
	URLPrivateDownload string `json:"url_private_download,omitempty"`
	Thumb360           string `json:"thumb_360,omitempty"`
	Thumb480           string `json:"thumb_480,omitempty"`
}

type slackAttachment struct {
	Fallback  string      `json:"fallback,omitempty"`
	Text      string      `json:"text,omitempty"`
	Title     string      `json:"title,omitempty"`
	TitleLink string      `json:"title_link,omitempty"`
	ImageURL  string      `json:"image_url,omitempty"`
	ThumbURL  string      `json:"thumb_url,omitempty"`
	Footer    string      `json:"footer,omitempty"`
	TS        json.Number `json:"ts,omitempty"`
}

type slackEdited struct {
	User string `json:"user,omitempty"`
	TS   string `json:"ts,omitempty"`
}

type slackMessage struct {
	Type        string            `json:"type"`
	Subtype     string            `json:"subtype,omitempty"`
	User        string            `json:"user,omitempty"`
	BotID       string            `json:"bot_id,omitempty"`
	Text        string            `json:"text,omitempty"`
	TS          string            `json:"ts"`
	ThreadTS    string            `json:"thread_ts,omitempty"`
	ReplyCount  int               `json:"reply_count,omitempty"`
	Reactions   []slackReaction   `json:"reactions,omitempty"`
	Attachments []slackAttachment `json:"attachments,omitempty"`
	Files       []slackFile       `json:"files,omitempty"`
	Edited      *slackEdited      `json:"edited,omitempty"`
}

type slackTopic struct {
	Value string `json:"value"`
}

type slackConversation struct {
	ID         string        `json:"id"`
	Name       string        `json:"name,omitempty"`
	NumMembers int           `json:"num_members,omitempty"`
	IsChannel  bool          `json:"is_channel,omitempty"`
	IsGroup    bool          `json:"is_group,omitempty"`
	IsIM       bool          `json:"is_im,omitempty"`
	IsMPIM     bool          `json:"is_mpim,omitempty"`
	IsPrivate  bool          `json:"is_private,omitempty"`
	IsArchived bool          `json:"is_archived,omitempty"`
	User       string        `json:"user,omitempty"`
	Topic      *slackTopic   `json:"topic,omitempty"`
	Purpose    *slackTopic   `json:"purpose,omitempty"`
	Latest     *slackMessage `json:"latest,omitempty"`
}

type listUsersResult struct {
	Users      []slackUser `json:"users"`
	NextCursor string      `json:"nextCursor,omitempty"`
}

type listConversationsResult struct {
	Conversations []slackConversation `json:"conversations"`
	NextCursor    string              `json:"nextCursor,omitempty"`
}

type conversationMembersResult struct {
	Members    []string `json:"members"`
	NextCursor string   `json:"nextCursor,omitempty"`
}

type messagesResult struct {
	Messages   []slackMessage `json:"messages"`
	HasMore    bool           `json:"hasMore"`
	NextCursor string         `json:"nextCursor,omitempty"`
}

type cookieTransport struct {
	base   http.RoundTripper
	cookie string
}

func (t cookieTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	clone.Header = req.Header.Clone()
	if t.cookie != "" {
		clone.Header.Set("Cookie", fmt.Sprintf("d=%s", t.cookie))
	}
	return t.base.RoundTrip(clone)
}

type runnerOptions struct {
	apiURL string
}

type helperRunner struct {
	apiURL string
}

func newHelperRunner(options runnerOptions) helperRunner {
	return helperRunner{apiURL: strings.TrimSpace(options.apiURL)}
}

func newSlackClient(credentials slackCredentials, apiURL string) (*slackapi.Client, error) {
	if strings.TrimSpace(credentials.Token) == "" || strings.TrimSpace(credentials.Cookie) == "" {
		return nil, errors.New("Slack credentials must include token and cookie")
	}

	client := &http.Client{
		Timeout: requestTimeout,
		Transport: cookieTransport{
			base:   http.DefaultTransport,
			cookie: credentials.Cookie,
		},
	}
	options := []slackapi.Option{
		slackapi.OptionHTTPClient(client),
		slackapi.OptionRetry(2),
	}
	if apiURL != "" {
		options = append(options, slackapi.OptionAPIURL(apiURL))
	}
	return slackapi.New(credentials.Token, options...), nil
}

func decodeRequest[T any](reader io.Reader) (T, error) {
	var input T
	if err := json.NewDecoder(reader).Decode(&input); err != nil {
		return input, err
	}
	return input, nil
}

func splitTypes(types string) []string {
	parts := strings.Split(types, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func toSlackUser(user slackapi.User) slackUser {
	return slackUser{
		ID:       user.ID,
		TeamID:   user.TeamID,
		Name:     user.Name,
		RealName: user.RealName,
		Deleted:  user.Deleted,
		Profile: slackUserProfile{
			RealName:      user.Profile.RealName,
			DisplayName:   user.Profile.DisplayName,
			Email:         user.Profile.Email,
			Image72:       user.Profile.Image72,
			Image192:      user.Profile.Image192,
			Image512:      user.Profile.Image512,
			ImageOriginal: user.Profile.ImageOriginal,
		},
	}
}

func toSlackReaction(reaction slackapi.ItemReaction) slackReaction {
	return slackReaction{
		Name:  reaction.Name,
		Count: reaction.Count,
		Users: append([]string(nil), reaction.Users...),
	}
}

func toSlackAttachment(attachment slackapi.Attachment) slackAttachment {
	return slackAttachment{
		Fallback:  attachment.Fallback,
		Text:      attachment.Text,
		Title:     attachment.Title,
		TitleLink: attachment.TitleLink,
		ImageURL:  attachment.ImageURL,
		ThumbURL:  attachment.ThumbURL,
		Footer:    attachment.Footer,
		TS:        attachment.Ts,
	}
}

func toSlackFile(file slackapi.File) slackFile {
	return slackFile{
		ID:                 file.ID,
		Name:               file.Name,
		Mimetype:           file.Mimetype,
		PrettyType:         file.PrettyType,
		Size:               file.Size,
		URLPrivate:         file.URLPrivate,
		URLPrivateDownload: file.URLPrivateDownload,
		Thumb360:           file.Thumb360,
		Thumb480:           file.Thumb480,
	}
}

func toSlackMessage(message slackapi.Message) slackMessage {
	attachments := make([]slackAttachment, 0, len(message.Attachments))
	for _, attachment := range message.Attachments {
		attachments = append(attachments, toSlackAttachment(attachment))
	}
	files := make([]slackFile, 0, len(message.Files))
	for _, file := range message.Files {
		files = append(files, toSlackFile(file))
	}
	reactions := make([]slackReaction, 0, len(message.Reactions))
	for _, reaction := range message.Reactions {
		reactions = append(reactions, toSlackReaction(reaction))
	}

	var edited *slackEdited
	if message.Edited != nil {
		edited = &slackEdited{
			User: message.Edited.User,
			TS:   message.Edited.Timestamp,
		}
	}

	return slackMessage{
		Type:        message.Type,
		Subtype:     message.SubType,
		User:        message.User,
		BotID:       message.BotID,
		Text:        message.Text,
		TS:          message.Timestamp,
		ThreadTS:    message.ThreadTimestamp,
		ReplyCount:  message.ReplyCount,
		Reactions:   reactions,
		Attachments: attachments,
		Files:       files,
		Edited:      edited,
	}
}

func toSlackConversation(channel slackapi.Channel) slackConversation {
	var latest *slackMessage
	if channel.Latest != nil {
		message := toSlackMessage(*channel.Latest)
		latest = &message
	}
	var topic *slackTopic
	if channel.Topic.Value != "" {
		topic = &slackTopic{Value: channel.Topic.Value}
	}
	var purpose *slackTopic
	if channel.Purpose.Value != "" {
		purpose = &slackTopic{Value: channel.Purpose.Value}
	}

	return slackConversation{
		ID:         channel.ID,
		Name:       channel.Name,
		NumMembers: channel.NumMembers,
		IsChannel:  channel.IsChannel,
		IsGroup:    channel.IsGroup,
		IsIM:       channel.IsIM,
		IsMPIM:     channel.IsMpIM,
		IsPrivate:  channel.IsPrivate,
		IsArchived: channel.IsArchived,
		User:       channel.User,
		Topic:      topic,
		Purpose:    purpose,
		Latest:     latest,
	}
}

func (r helperRunner) run(ctx context.Context, command string, stdin io.Reader) (any, error) {
	switch command {
	case "version":
		return versionResult{Version: helperVersion, ProtocolVersion: protocolVersion}, nil
	case "status":
		return statusResult{HelperVersion: helperVersion, ProtocolVersion: protocolVersion}, nil
	case "authTest":
		input, err := decodeRequest[authTestRequest](stdin)
		if err != nil {
			return nil, err
		}
		client, err := newSlackClient(input.Credentials, r.apiURL)
		if err != nil {
			return nil, err
		}
		auth, err := client.AuthTestContext(ctx)
		if err != nil {
			return nil, err
		}
		return slackAuthTestResponse{
			OK:     true,
			Team:   auth.Team,
			User:   auth.User,
			TeamID: auth.TeamID,
			UserID: auth.UserID,
		}, nil
	case "listUsers":
		input, err := decodeRequest[listUsersRequest](stdin)
		if err != nil {
			return nil, err
		}
		client, err := newSlackClient(input.Credentials, r.apiURL)
		if err != nil {
			return nil, err
		}
		pagination := client.GetUsersPaginated(
			slackapi.GetUsersOptionLimit(input.Limit),
			slackapi.GetUsersOptionCursor(input.Cursor),
		)
		page, err := pagination.Next(ctx)
		if err != nil {
			return nil, err
		}
		users := make([]slackUser, 0, len(page.Users))
		for _, user := range page.Users {
			users = append(users, toSlackUser(user))
		}
		return listUsersResult{Users: users, NextCursor: page.Cursor}, nil
	case "listConversations":
		input, err := decodeRequest[listConversationsRequest](stdin)
		if err != nil {
			return nil, err
		}
		client, err := newSlackClient(input.Credentials, r.apiURL)
		if err != nil {
			return nil, err
		}
		channels, nextCursor, err := client.GetConversationsForUserContext(ctx, &slackapi.GetConversationsForUserParameters{
			Types:  splitTypes(input.Types),
			Cursor: input.Cursor,
			Limit:  input.Limit,
		})
		if err != nil {
			return nil, err
		}
		conversations := make([]slackConversation, 0, len(channels))
		for _, channel := range channels {
			conversations = append(conversations, toSlackConversation(channel))
		}
		return listConversationsResult{Conversations: conversations, NextCursor: nextCursor}, nil
	case "getConversationMembers":
		input, err := decodeRequest[conversationMembersRequest](stdin)
		if err != nil {
			return nil, err
		}
		client, err := newSlackClient(input.Credentials, r.apiURL)
		if err != nil {
			return nil, err
		}
		members, nextCursor, err := client.GetUsersInConversationContext(ctx, &slackapi.GetUsersInConversationParameters{
			ChannelID: input.Channel,
			Cursor:    input.Cursor,
			Limit:     input.Limit,
		})
		if err != nil {
			return nil, err
		}
		return conversationMembersResult{Members: members, NextCursor: nextCursor}, nil
	case "getHistory":
		input, err := decodeRequest[historyRequest](stdin)
		if err != nil {
			return nil, err
		}
		client, err := newSlackClient(input.Credentials, r.apiURL)
		if err != nil {
			return nil, err
		}
		history, err := client.GetConversationHistoryContext(ctx, &slackapi.GetConversationHistoryParameters{
			ChannelID: input.Channel,
			Cursor:    input.Cursor,
			Oldest:    input.Oldest,
			Limit:     input.Limit,
		})
		if err != nil {
			return nil, err
		}
		messages := make([]slackMessage, 0, len(history.Messages))
		for _, message := range history.Messages {
			messages = append(messages, toSlackMessage(message))
		}
		return messagesResult{
			Messages:   messages,
			HasMore:    history.HasMore,
			NextCursor: history.ResponseMetaData.NextCursor,
		}, nil
	case "getReplies":
		input, err := decodeRequest[repliesRequest](stdin)
		if err != nil {
			return nil, err
		}
		client, err := newSlackClient(input.Credentials, r.apiURL)
		if err != nil {
			return nil, err
		}
		replies, hasMore, nextCursor, err := client.GetConversationRepliesContext(ctx, &slackapi.GetConversationRepliesParameters{
			ChannelID: input.Channel,
			Timestamp: input.ThreadTS,
			Cursor:    input.Cursor,
			Oldest:    input.Oldest,
			Limit:     input.Limit,
		})
		if err != nil {
			return nil, err
		}
		messages := make([]slackMessage, 0, len(replies))
		for _, message := range replies {
			messages = append(messages, toSlackMessage(message))
		}
		return messagesResult{
			Messages:   messages,
			HasMore:    hasMore,
			NextCursor: nextCursor,
		}, nil
	case "session":
		return nil, errors.New("session must be run through runSession")
	default:
		return nil, fmt.Errorf("unknown command: %s", command)
	}
}

func writeJSON(writer io.Writer, value any) error {
	encoder := json.NewEncoder(writer)
	return encoder.Encode(value)
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: cued-slack-helper <version|status|authTest|listUsers|listConversations|getConversationMembers|getHistory|getReplies|session>")
		os.Exit(1)
	}

	command := os.Args[1]
	baseCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(baseCtx, requestTimeout)
	defer cancel()

	runner := newHelperRunner(runnerOptions{
		apiURL: os.Getenv("CUED_SLACK_HELPER_API_URL"),
	})

	if command == "session" {
		sessionCtx := baseCtx
		if err := runner.runSession(sessionCtx, os.Stdin, os.Stdout); err != nil {
			_ = writeSessionEvent(os.Stdout, "disconnected", disconnectedEventData{Reason: err.Error()})
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(1)
		}
		return
	}

	result, err := runner.run(ctx, command, os.Stdin)
	if err != nil {
		if command == "version" || command == "status" {
			_ = writeJSON(os.Stdout, map[string]any{
				"helperVersion":   helperVersion,
				"protocolVersion": protocolVersion,
				"error":           err.Error(),
			})
			os.Exit(1)
		}
		_ = writeJSON(os.Stdout, commandEnvelope{
			OK:              false,
			ProtocolVersion: protocolVersion,
			Error:           err.Error(),
		})
		os.Exit(1)
	}

	if command == "version" || command == "status" {
		_ = writeJSON(os.Stdout, result)
		return
	}

	_ = writeJSON(os.Stdout, commandEnvelope{
		OK:              true,
		ProtocolVersion: protocolVersion,
		Result:          result,
	})
}
