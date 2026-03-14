package main

import (
	"context"
	"strconv"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	waProto "go.mau.fi/whatsmeow/binary/proto"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	waWeb "go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

func TestWaitForPairingCompletionWaitsForConnectedAfterSuccess(t *testing.T) {
	qrChan := make(chan whatsmeow.QRChannelItem, 1)
	done := make(chan struct{})
	qrChan <- whatsmeow.QRChannelSuccess
	close(qrChan)

	go func() {
		time.Sleep(10 * time.Millisecond)
		close(done)
	}()

	if err := waitForPairingCompletion(context.Background(), qrChan, done, nil); err != nil {
		t.Fatalf("expected pairing completion to succeed, got %v", err)
	}
}

func TestWaitForPairingCompletionFailsWhenChannelClosesBeforeSuccess(t *testing.T) {
	qrChan := make(chan whatsmeow.QRChannelItem)
	close(qrChan)

	err := waitForPairingCompletion(context.Background(), qrChan, make(chan struct{}), nil)
	if err == nil || err.Error() != "QR channel closed before pairing completed" {
		t.Fatalf("expected early channel close error, got %v", err)
	}
}

func TestResyncPagePaginatesFullHistory(t *testing.T) {
	storeDir := t.TempDir()
	state, err := newHelperState(storeDir)
	if err != nil {
		t.Fatalf("newHelperState failed: %v", err)
	}
	defer state.close()

	for index := 0; index < 1_205; index++ {
		state.setMessage(messageSnapshot{
			MessageID: "wamid-" + strconv.Itoa(index),
			ChatJID:   "12016824050@s.whatsapp.net",
			FromMe:    index%2 == 0,
			Timestamp: int64(index + 1),
			Text:      "hello",
		})
	}

	firstPage, err := state.getResyncPage(nil, "", 1_000)
	if err != nil {
		t.Fatalf("first resync page failed: %v", err)
	}
	if len(firstPage.Messages) != 1_000 || !firstPage.HasMore || firstPage.NextCursor == nil {
		t.Fatalf("unexpected first page: %+v", firstPage)
	}

	secondPage, err := state.getResyncPage(nil, *firstPage.NextCursor, 1_000)
	if err != nil {
		t.Fatalf("second resync page failed: %v", err)
	}
	if len(secondPage.Messages) != 205 || secondPage.HasMore || secondPage.NextCursor != nil {
		t.Fatalf("unexpected second page: %+v", secondPage)
	}
}

func TestResyncPageFiltersIncrementalUpdates(t *testing.T) {
	storeDir := t.TempDir()
	state, err := newHelperState(storeDir)
	if err != nil {
		t.Fatalf("newHelperState failed: %v", err)
	}
	defer state.close()

	if err := state.applySnapshot(stateSnapshot{
		Contacts: []contactSnapshot{{JID: "15551234567@s.whatsapp.net"}},
		Chats:    []chatSnapshot{{JID: "15551234567@s.whatsapp.net"}},
		Messages: []messageSnapshot{{
			MessageID: "wamid-new",
			ChatJID:   "15551234567@s.whatsapp.net",
			Timestamp: 2,
			Text:      "new",
		}},
	}); err != nil {
		t.Fatalf("applySnapshot failed: %v", err)
	}

	since := time.Now().UnixMilli() - 1
	state.setMessage(messageSnapshot{
		MessageID: "wamid-latest",
		ChatJID:   "15551234567@s.whatsapp.net",
		Timestamp: 3,
		Text:      "latest",
	})

	page, err := state.getResyncPage(&since, "", 100)
	if err != nil {
		t.Fatalf("incremental resync failed: %v", err)
	}
	if len(page.Messages) != 1 || page.Messages[0].MessageID != "wamid-latest" {
		t.Fatalf("expected only newest message, got %+v", page.Messages)
	}
}

func TestHistorySyncBatchFromEventUsesHistoryPayload(t *testing.T) {
	event := &events.HistorySync{
		Data: &waHistorySync.HistorySync{
			Pushnames: []*waHistorySync.Pushname{
				{
					ID:       proto.String("15551234567@s.whatsapp.net"),
					Pushname: proto.String("Theo"),
				},
			},
			Conversations: []*waHistorySync.Conversation{
				{
					ID:   proto.String("15551234567@s.whatsapp.net"),
					Name: proto.String("Theo"),
					Messages: []*waHistorySync.HistorySyncMsg{
						{
							Message: &waWeb.WebMessageInfo{
								Key: &waCommon.MessageKey{
									ID:        proto.String("wamid-history"),
									RemoteJID: proto.String("15551234567@s.whatsapp.net"),
									FromMe:    proto.Bool(false),
								},
								MessageTimestamp: proto.Uint64(1_710_000_000),
								PushName:         proto.String("Theo"),
								Message: &waProto.Message{
									Conversation: proto.String("from history"),
								},
							},
						},
					},
				},
			},
		},
	}

	snapshot := historySyncBatchFromEvent(nil, event)
	if len(snapshot.Messages) != 1 || snapshot.Messages[0].MessageID != "wamid-history" {
		t.Fatalf("expected history message in snapshot, got %+v", snapshot.Messages)
	}
	if len(snapshot.Contacts) == 0 || snapshot.Contacts[0].PushName == nil || *snapshot.Contacts[0].PushName != "Theo" {
		t.Fatalf("expected pushname contact in snapshot, got %+v", snapshot.Contacts)
	}
	if len(snapshot.Chats) != 1 || snapshot.Chats[0].JID != "15551234567@s.whatsapp.net" {
		t.Fatalf("expected chat in snapshot, got %+v", snapshot.Chats)
	}
}
