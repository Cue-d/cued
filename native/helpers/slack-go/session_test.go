package main

import (
	"testing"
	"time"
)

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

func TestAdaptiveSessionPollInterval(t *testing.T) {
	for _, test := range []struct {
		quiet int
		want  time.Duration
	}{
		{0, 15 * time.Second}, {1, 30 * time.Second}, {2, 60 * time.Second}, {100, 60 * time.Second}, {-1, 15 * time.Second},
	} {
		if got := adaptiveSessionPollInterval(defaultSessionPollInterval, test.quiet); got != test.want {
			t.Fatalf("quiet=%d: got %v want %v", test.quiet, got, test.want)
		}
	}
	if got := adaptiveSessionPollInterval(5*time.Second, 2); got != 5*time.Second {
		t.Fatalf("explicit interval changed: %v", got)
	}
}

func TestQuietSessionPollCountOverOneHour(t *testing.T) {
	countPolls := func(adaptive bool) int {
		count, quiet := 0, 0
		for elapsed := time.Duration(0); elapsed < time.Hour; {
			count++
			quiet++
			interval := defaultSessionPollInterval
			if adaptive {
				interval = adaptiveSessionPollInterval(interval, quiet)
			}
			elapsed += interval
		}
		return count
	}
	before, after := countPolls(false), countPolls(true)
	if before != 240 || after != 61 {
		t.Fatalf("unexpected quiet-hour poll counts: before=%d after=%d", before, after)
	}
	t.Logf("one quiet hour: fixed=%d adaptive=%d poll cycles", before, after)
}
