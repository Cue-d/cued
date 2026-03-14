package main

import (
	"context"
	"encoding/json"
	"io"
	"strconv"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	waProto "go.mau.fi/whatsmeow/binary/proto"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waCompanionReg"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	waWeb "go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
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

	var since int64
	if err := state.cache.db.QueryRow(`SELECT MAX(updated_at) FROM messages`).Scan(&since); err != nil {
		t.Fatalf("failed to read message watermark: %v", err)
	}
	time.Sleep(time.Millisecond)
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

func TestHandleHistorySyncEventPersistsMetadata(t *testing.T) {
	storeDir := t.TempDir()
	state, err := newHelperState(storeDir)
	if err != nil {
		t.Fatalf("newHelperState failed: %v", err)
	}
	defer state.close()

	runtime := newHelperRuntime(nil, state, json.NewEncoder(io.Discard))
	runtime.handleHistorySyncEvent(&events.HistorySync{
		Data: &waHistorySync.HistorySync{
			SyncType:   waHistorySync.HistorySync_FULL.Enum(),
			ChunkOrder: proto.Uint32(7),
			Progress:   proto.Uint32(42),
			Conversations: []*waHistorySync.Conversation{{
				ID: proto.String("15551234567@s.whatsapp.net"),
				Messages: []*waHistorySync.HistorySyncMsg{{
					Message: &waWeb.WebMessageInfo{
						Key:              &waCommon.MessageKey{ID: proto.String("wamid-1")},
						MessageTimestamp: proto.Uint64(1),
						Message:          &waProto.Message{Conversation: proto.String("hello")},
					},
				}},
			}},
		},
	})

	metadata := state.getMetadata()
	if metadata.LastHistorySyncAt == 0 {
		t.Fatalf("expected history sync timestamp to be recorded")
	}
	if metadata.LastHistorySyncType != waHistorySync.HistorySync_FULL.String() {
		t.Fatalf("unexpected history sync type: %q", metadata.LastHistorySyncType)
	}
	if metadata.LastHistoryChunkOrder != 7 {
		t.Fatalf("unexpected history sync chunk order: %d", metadata.LastHistoryChunkOrder)
	}
	if metadata.LastHistoryProgress != 42 {
		t.Fatalf("unexpected history sync progress: %d", metadata.LastHistoryProgress)
	}
}

func TestConfigureClientPayloadRequestsFullHistory(t *testing.T) {
	configureClientPayload()

	if store.DeviceProps.GetRequireFullSync() != true {
		t.Fatalf("expected helper to require full history sync")
	}

	config := store.DeviceProps.GetHistorySyncConfig()
	if config == nil {
		t.Fatalf("expected history sync config to be configured")
	}
	if got := config.GetFullSyncDaysLimit(); got != fullHistorySyncDaysLimit {
		t.Fatalf("unexpected full sync days limit: %d", got)
	}
	if got := config.GetRecentSyncDaysLimit(); got != fullHistorySyncDaysLimit {
		t.Fatalf("unexpected recent sync days limit: %d", got)
	}
	if got := config.GetSupportGroupHistory(); got != true {
		t.Fatalf("expected group history support to be enabled")
	}
	if got := config.GetOnDemandReady(); got != true {
		t.Fatalf("expected on-demand history sync to be enabled")
	}
	if got := config.GetCompleteOnDemandReady(); got != true {
		t.Fatalf("expected complete on-demand history sync to be enabled")
	}
	if got := store.DeviceProps.GetPlatformType(); got != waCompanionReg.DeviceProps_DESKTOP {
		t.Fatalf("unexpected platform type: %v", got)
	}
}

func TestHistorySyncNotificationQueueRoundTrip(t *testing.T) {
	storeDir := t.TempDir()
	state, err := newHelperState(storeDir)
	if err != nil {
		t.Fatalf("newHelperState failed: %v", err)
	}
	defer state.close()

	notification := &waProto.HistorySyncNotification{
		ChunkOrder: proto.Uint32(3),
		Progress:   proto.Uint32(77),
	}
	if err := state.cache.enqueueHistorySyncNotification(notification); err != nil {
		t.Fatalf("enqueue failed: %v", err)
	}

	rowID, next, err := state.cache.getNextHistorySyncNotification()
	if err != nil {
		t.Fatalf("getNext failed: %v", err)
	}
	if rowID == 0 || next == nil {
		t.Fatalf("expected queued notification, got rowID=%d notif=%v", rowID, next)
	}
	if next.GetChunkOrder() != 3 || next.GetProgress() != 77 {
		t.Fatalf("unexpected notification round trip: %+v", next)
	}
	if err := state.cache.deleteHistorySyncNotification(rowID); err != nil {
		t.Fatalf("delete failed: %v", err)
	}
	rowID, next, err = state.cache.getNextHistorySyncNotification()
	if err != nil {
		t.Fatalf("second getNext failed: %v", err)
	}
	if rowID != 0 || next != nil {
		t.Fatalf("expected empty queue, got rowID=%d notif=%v", rowID, next)
	}
}

func TestHandleMessageEventQueuesHistorySyncNotification(t *testing.T) {
	storeDir := t.TempDir()
	state, err := newHelperState(storeDir)
	if err != nil {
		t.Fatalf("newHelperState failed: %v", err)
	}
	defer state.close()

	runtime := newHelperRuntime(nil, state, json.NewEncoder(io.Discard))
	runtime.handleMessageEvent(&events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{
				IsFromMe: true,
			},
		},
		Message: &waProto.Message{
			ProtocolMessage: &waProto.ProtocolMessage{
				HistorySyncNotification: &waProto.HistorySyncNotification{
					ChunkOrder: proto.Uint32(2),
					Progress:   proto.Uint32(55),
				},
			},
		},
	})

	rowID, notification, err := state.cache.getNextHistorySyncNotification()
	if err != nil {
		t.Fatalf("getNext failed: %v", err)
	}
	if rowID == 0 || notification == nil {
		t.Fatalf("expected queued notification, got rowID=%d notif=%v", rowID, notification)
	}
	if notification.GetChunkOrder() != 2 || notification.GetProgress() != 55 {
		t.Fatalf("unexpected queued notification telemetry: %+v", notification)
	}

	metadata := state.getMetadata()
	if metadata.LastHistoryNotificationAt == 0 {
		t.Fatalf("expected history notification timestamp to be recorded")
	}

	var messageCount int
	if err := state.cache.db.QueryRow(`SELECT COUNT(*) FROM messages`).Scan(&messageCount); err != nil {
		t.Fatalf("failed to count messages: %v", err)
	}
	if messageCount != 0 {
		t.Fatalf("expected protocol history sync message to be skipped, got %d messages", messageCount)
	}

	queueCount, err := state.cache.countHistorySyncNotifications()
	if err != nil {
		t.Fatalf("failed to count queued history sync notifications: %v", err)
	}
	if queueCount != 1 {
		t.Fatalf("expected one queued history sync notification, got %d", queueCount)
	}
}

func TestApplyHistorySyncDataClearsHistorySyncError(t *testing.T) {
	storeDir := t.TempDir()
	state, err := newHelperState(storeDir)
	if err != nil {
		t.Fatalf("newHelperState failed: %v", err)
	}
	defer state.close()

	state.setMetadata(helperMetadata{
		LastHistorySyncError: "failed to download history sync notification: timeout",
	})

	runtime := newHelperRuntime(nil, state, json.NewEncoder(io.Discard))
	err = runtime.applyHistorySyncData(&waHistorySync.HistorySync{
		SyncType:   waHistorySync.HistorySync_FULL.Enum(),
		ChunkOrder: proto.Uint32(1),
		Progress:   proto.Uint32(100),
		Conversations: []*waHistorySync.Conversation{{
			ID: proto.String("15551234567@s.whatsapp.net"),
			Messages: []*waHistorySync.HistorySyncMsg{{
				Message: &waWeb.WebMessageInfo{
					Key:              &waCommon.MessageKey{ID: proto.String("wamid-apply")},
					MessageTimestamp: proto.Uint64(1),
					Message:          &waProto.Message{Conversation: proto.String("hello")},
				},
			}},
		}},
	})
	if err != nil {
		t.Fatalf("applyHistorySyncData failed: %v", err)
	}

	metadata := state.getMetadata()
	if metadata.LastHistorySyncError != "" {
		t.Fatalf("expected history sync error to clear after success, got %q", metadata.LastHistorySyncError)
	}
}

func TestConnectedEventPreservesHistorySyncMetadata(t *testing.T) {
	storeDir := t.TempDir()
	state, err := newHelperState(storeDir)
	if err != nil {
		t.Fatalf("newHelperState failed: %v", err)
	}
	defer state.close()

	state.setMetadata(helperMetadata{
		LastHistorySyncAt:         123,
		LastHistorySyncType:       "FULL",
		LastHistoryChunkOrder:     2,
		LastHistoryProgress:       100,
		LastHistoryNotificationAt: 122,
	})

	client := whatsmeow.NewClient(&store.Device{
		PushName: "Theo Tarr",
		ID: &types.JID{
			User:   "13474468966",
			Server: types.DefaultUserServer,
		},
	}, nil)
	runtime := newHelperRuntime(client, state, json.NewEncoder(io.Discard))
	runtime.handleEvent(&events.Connected{})

	metadata := state.getMetadata()
	if metadata.AccountJID != "13474468966@s.whatsapp.net" {
		t.Fatalf("unexpected account jid: %q", metadata.AccountJID)
	}
	if metadata.LastHistorySyncAt != 123 || metadata.LastHistorySyncType != "FULL" {
		t.Fatalf("expected history sync metadata to survive connect, got %+v", metadata)
	}
	if metadata.LastHistoryChunkOrder != 2 || metadata.LastHistoryProgress != 100 {
		t.Fatalf("expected history sync chunk/progress to survive connect, got %+v", metadata)
	}
}
