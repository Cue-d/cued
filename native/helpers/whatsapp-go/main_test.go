package main

import (
	"fmt"
	"testing"
)

func TestHelperStateRetainsDownloadableMediaBeyondSnapshotTrim(t *testing.T) {
	state, err := newHelperState(t.TempDir())
	if err != nil {
		t.Fatalf("newHelperState: %v", err)
	}

	protoValue := "encoded-message"
	for index := range 5001 {
		message := messageSnapshot{
			MessageID: fmt.Sprintf("message-%d", index),
			ChatJID:   "12015550123@s.whatsapp.net",
			Text:      "hello",
		}
		if index == 0 {
			message.MessageProto = &protoValue
			message.Attachments = []attachmentSnapshot{
				{
					ID:         "attachment-0",
					Kind:       "image",
					AccessKind: "provider_fetch",
				},
			}
		}
		state.setMessage(message)
	}

	if got := len(state.getSnapshot().Messages); got != 5000 {
		t.Fatalf("snapshot retained %d messages, want 5000", got)
	}
	if message := state.findMessage("12015550123@s.whatsapp.net", "message-0"); message == nil {
		t.Fatal("trimmed media message was not found")
	} else if message.MessageProto == nil || *message.MessageProto != protoValue {
		t.Fatalf("unexpected proto for trimmed media message: %#v", message.MessageProto)
	}

	reloaded, err := newHelperState(state.storeDir)
	if err != nil {
		t.Fatalf("reload helper state: %v", err)
	}
	if message := reloaded.findMessage("12015550123@s.whatsapp.net", "message-0"); message == nil {
		t.Fatal("reloaded helper state lost downloadable media metadata")
	} else if len(message.Attachments) != 1 {
		t.Fatalf("reloaded helper state kept %d attachments, want 1", len(message.Attachments))
	}
}
