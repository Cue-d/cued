package main

import "testing"

func TestConversationVersionKeyIgnoresChannelMemberCount(t *testing.T) {
	conversation := slackConversation{
		ID:        "C123",
		Name:      "general",
		IsChannel: true,
		Latest:    &slackMessage{TS: "1710000000.000100"},
	}

	left := conversationVersionKey(conversation, []string{"U1", "U2", "U3"}, "general")
	right := conversationVersionKey(conversation, nil, "general")

	if left != right {
		t.Fatalf("channel version should ignore member count: %q != %q", left, right)
	}
}

func TestConversationVersionKeyTracksMPIMMembership(t *testing.T) {
	conversation := slackConversation{
		ID:     "G123",
		Name:   "group",
		IsMPIM: true,
		Latest: &slackMessage{TS: "1710000000.000100"},
	}

	left := conversationVersionKey(conversation, []string{"U1", "U2"}, "group")
	right := conversationVersionKey(conversation, []string{"U1", "U2", "U3"}, "group")

	if left == right {
		t.Fatalf("mpim version should change when membership changes: %q", left)
	}
}
