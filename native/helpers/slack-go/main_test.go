package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestVersionAndStatus(t *testing.T) {
	runner := newHelperRunner(runnerOptions{})

	version, err := runner.run(context.Background(), "version", bytes.NewReader(nil))
	if err != nil {
		t.Fatalf("version: %v", err)
	}
	if version.(versionResult).Version != helperVersion {
		t.Fatalf("version mismatch: %v", version)
	}

	status, err := runner.run(context.Background(), "status", bytes.NewReader(nil))
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if status.(statusResult).HelperVersion != helperVersion {
		t.Fatalf("status mismatch: %v", status)
	}
}

func TestSlackCommands(t *testing.T) {
	var lastForm url.Values
	var lastCookie string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lastCookie = r.Header.Get("Cookie")
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		lastForm = r.PostForm

		w.Header().Set("content-type", "application/json")
		switch r.URL.Path {
		case "/auth.test":
			_, _ = w.Write([]byte(`{"ok":true,"team":"Acme","user":"Ava","team_id":"T123","user_id":"U123"}`))
		case "/users.list":
			_, _ = w.Write([]byte(`{"ok":true,"members":[{"id":"U123","team_id":"T123","name":"ava","real_name":"Ava","profile":{"email":"ava@example.com","image_72":"https://img/72.png"}}],"response_metadata":{"next_cursor":"users-next"}}`))
		case "/conversations.list":
			_, _ = w.Write([]byte(`{"ok":true,"channels":[{"id":"C123","name":"general","num_members":2,"is_channel":true,"is_private":false,"topic":{"value":"ship"},"purpose":{"value":"build"},"latest":{"type":"message","user":"U123","text":"hello","ts":"1710000000.000100"}}],"response_metadata":{"next_cursor":"conv-next"}}`))
		case "/conversations.members":
			_, _ = w.Write([]byte(`{"ok":true,"members":["U123","U456"],"response_metadata":{"next_cursor":"members-next"}}`))
		case "/conversations.history":
			_, _ = w.Write([]byte(`{"ok":true,"messages":[{"type":"message","user":"U123","text":"history","ts":"1710000001.000100","files":[{"id":"F123","name":"doc.pdf","pretty_type":"PDF","url_private":"https://files/private"}],"attachments":[{"text":"attachment","thumb_url":"https://img/thumb.png","ts":"1710000001"}],"reactions":[{"name":"thumbsup","count":1,"users":["U456"]}],"edited":{"user":"U123","ts":"1710000002.000000"}}],"has_more":true,"response_metadata":{"next_cursor":"history-next"}}`))
		case "/conversations.replies":
			_, _ = w.Write([]byte(`{"ok":true,"messages":[{"type":"message","user":"U456","text":"reply","ts":"1710000003.000100","thread_ts":"1710000001.000100"}],"has_more":false,"response_metadata":{"next_cursor":"replies-next"}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	runner := newHelperRunner(runnerOptions{
		apiURL: server.URL + "/",
	})
	credentials := slackCredentials{Token: "xoxc-test", Cookie: "cookie-test"}

	t.Run("authTest", func(t *testing.T) {
		output := runCommandJSON[tSlackAuthTestResponse](t, runner, "authTest", authTestRequest{Credentials: credentials})
		if !output.OK || output.TeamID != "T123" || output.UserID != "U123" {
			t.Fatalf("unexpected auth output: %+v", output)
		}
		if lastCookie != "d=cookie-test" {
			t.Fatalf("cookie missing: %q", lastCookie)
		}
	})

	t.Run("listUsers", func(t *testing.T) {
		output := runCommandJSON[listUsersResult](t, runner, "listUsers", listUsersRequest{
			Credentials: credentials,
			Cursor:      "cursor-a",
			Limit:       50,
		})
		if got, want := output.NextCursor, "users-next"; got != want {
			t.Fatalf("next cursor = %q, want %q", got, want)
		}
		if lastForm.Get("cursor") != "cursor-a" || lastForm.Get("limit") != "50" {
			t.Fatalf("unexpected users params: %v", lastForm)
		}
	})

	t.Run("listConversations", func(t *testing.T) {
		output := runCommandJSON[listConversationsResult](t, runner, "listConversations", listConversationsRequest{
			Credentials: credentials,
			Types:       "im,mpim,private_channel,public_channel",
			Cursor:      "cursor-b",
			Limit:       200,
		})
		if got, want := output.NextCursor, "conv-next"; got != want {
			t.Fatalf("next cursor = %q, want %q", got, want)
		}
		if lastForm.Get("types") != "im,mpim,private_channel,public_channel" {
			t.Fatalf("unexpected types: %v", lastForm)
		}
		if _, exists := lastForm["exclude_archived"]; exists {
			t.Fatalf("exclude_archived should be omitted: %v", lastForm)
		}
	})

	t.Run("getConversationMembers", func(t *testing.T) {
		output := runCommandJSON[conversationMembersResult](t, runner, "getConversationMembers", conversationMembersRequest{
			Credentials: credentials,
			Channel:     "C123",
			Cursor:      "cursor-c",
			Limit:       10,
		})
		if got, want := output.NextCursor, "members-next"; got != want {
			t.Fatalf("next cursor = %q, want %q", got, want)
		}
		if lastForm.Get("channel") != "C123" {
			t.Fatalf("unexpected members params: %v", lastForm)
		}
	})

	t.Run("getHistory", func(t *testing.T) {
		output := runCommandJSON[messagesResult](t, runner, "getHistory", historyRequest{
			Credentials: credentials,
			Channel:     "C123",
			Cursor:      "cursor-d",
			Oldest:      "1710000000.000000",
			Limit:       100,
		})
		if !output.HasMore || output.NextCursor != "history-next" {
			t.Fatalf("unexpected history output: %+v", output)
		}
		if lastForm.Get("oldest") != "1710000000.000000" {
			t.Fatalf("unexpected history params: %v", lastForm)
		}
	})

	t.Run("getReplies", func(t *testing.T) {
		output := runCommandJSON[messagesResult](t, runner, "getReplies", repliesRequest{
			Credentials: credentials,
			Channel:     "C123",
			ThreadTS:    "1710000001.000100",
			Cursor:      "cursor-e",
			Oldest:      "1710000000.000000",
			Limit:       100,
		})
		if output.HasMore || output.NextCursor != "replies-next" {
			t.Fatalf("unexpected replies output: %+v", output)
		}
		if lastForm.Get("ts") != "1710000001.000100" {
			t.Fatalf("unexpected replies params: %v", lastForm)
		}
	})
}

func TestRunSessionCommandEmitsSingleDisconnectedEvent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch r.URL.Path {
		case "/auth.test":
			_, _ = w.Write([]byte(`{"ok":true,"team":"Acme","user":"Ava","team_id":"T123","user_id":"U123"}`))
		case "/users.list":
			_, _ = w.Write([]byte(`{"ok":true,"members":[],"response_metadata":{"next_cursor":""}}`))
		case "/users.conversations":
			_, _ = w.Write([]byte(`{"ok":false,"error":"rate_limited"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	runner := newHelperRunner(runnerOptions{
		apiURL: server.URL + "/",
	})
	payload, err := json.Marshal(sessionRequest{
		Credentials: slackCredentials{Token: "xoxc-test", Cookie: "cookie-test"},
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	exitCode := runSessionCommand(
		runner,
		context.Background(),
		bytes.NewReader(payload),
		&stdout,
		&stderr,
	)
	if exitCode != 1 {
		t.Fatalf("exit code = %d, want 1", exitCode)
	}
	if !strings.Contains(stderr.String(), "rate_limited") {
		t.Fatalf("stderr = %q, want rate_limited", stderr.String())
	}

	disconnectedCount := 0
	decoder := json.NewDecoder(bytes.NewReader(stdout.Bytes()))
	for decoder.More() {
		var envelope sessionEventEnvelope
		if err := decoder.Decode(&envelope); err != nil {
			t.Fatalf("decode session event: %v", err)
		}
		if envelope.Event == "disconnected" {
			disconnectedCount++
		}
	}
	if disconnectedCount != 1 {
		t.Fatalf("disconnected event count = %d, want 1; output=%s", disconnectedCount, stdout.String())
	}
}

func TestRunSessionCommandEmitsDisconnectedWhenInitialUserRefreshFails(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch r.URL.Path {
		case "/auth.test":
			_, _ = w.Write([]byte(`{"ok":true,"team":"Acme","user":"Ava","team_id":"T123","user_id":"U123"}`))
		case "/users.list":
			_, _ = w.Write([]byte(`{"ok":false,"error":"users_failed"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	runner := newHelperRunner(runnerOptions{
		apiURL: server.URL + "/",
	})
	payload, err := json.Marshal(sessionRequest{
		Credentials: slackCredentials{Token: "xoxc-test", Cookie: "cookie-test"},
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	exitCode := runSessionCommand(
		runner,
		context.Background(),
		bytes.NewReader(payload),
		&stdout,
		&stderr,
	)
	if exitCode != 1 {
		t.Fatalf("exit code = %d, want 1", exitCode)
	}

	events := make([]sessionEventEnvelope, 0)
	decoder := json.NewDecoder(bytes.NewReader(stdout.Bytes()))
	for decoder.More() {
		var envelope sessionEventEnvelope
		if err := decoder.Decode(&envelope); err != nil {
			t.Fatalf("decode session event: %v", err)
		}
		events = append(events, envelope)
	}
	if len(events) != 2 {
		t.Fatalf("event count = %d, want 2; output=%s", len(events), stdout.String())
	}
	if events[0].Event != "connected" || events[1].Event != "disconnected" {
		t.Fatalf("unexpected events: %+v", events)
	}
}

type responseEnvelope[T any] struct {
	OK              bool   `json:"ok"`
	ProtocolVersion int    `json:"protocolVersion"`
	Error           string `json:"error,omitempty"`
	Result          T      `json:"result"`
}

type tSlackAuthTestResponse = slackAuthTestResponse

func runCommandJSON[T any](t *testing.T, runner helperRunner, command string, payload any) T {
	t.Helper()

	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	output, err := runner.run(context.Background(), command, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("%s: %v", command, err)
	}

	encoded, err := json.Marshal(output)
	if err != nil {
		t.Fatalf("marshal output: %v", err)
	}
	var typed T
	if err := json.Unmarshal(encoded, &typed); err != nil {
		t.Fatalf("unmarshal output: %v", err)
	}
	return typed
}
