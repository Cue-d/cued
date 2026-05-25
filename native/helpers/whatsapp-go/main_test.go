package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	waProto "go.mau.fi/whatsmeow/binary/proto"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waCompanionReg"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waSyncAction"
	"go.mau.fi/whatsmeow/proto/waWa6"
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

func TestResyncPagePaginatesCallsAfterMessages(t *testing.T) {
	storeDir := t.TempDir()
	state, err := newHelperState(storeDir)
	if err != nil {
		t.Fatalf("newHelperState failed: %v", err)
	}
	defer state.close()

	for index := 0; index < 3; index++ {
		state.setMessage(messageSnapshot{
			MessageID: "wamid-" + strconv.Itoa(index),
			ChatJID:   "12016824050@s.whatsapp.net",
			FromMe:    index%2 == 0,
			Timestamp: int64(index + 1),
			Text:      "hello",
		})
		if err := state.applySnapshot(stateSnapshot{Calls: []callSnapshot{{
			CallID:    "call-" + strconv.Itoa(index),
			ChatJID:   "12016824050@s.whatsapp.net",
			FromMe:    index%2 == 0,
			Timestamp: int64(index + 1),
			Status:    "completed",
			Medium:    "audio",
		}}}); err != nil {
			t.Fatalf("apply call snapshot failed: %v", err)
		}
	}

	firstPage, err := state.getResyncPage(nil, "", 2)
	if err != nil {
		t.Fatalf("first resync page failed: %v", err)
	}
	if len(firstPage.Messages) != 2 || len(firstPage.Calls) != 0 || !firstPage.HasMore || firstPage.NextCursor == nil {
		t.Fatalf("unexpected first page: %+v", firstPage)
	}

	secondPage, err := state.getResyncPage(nil, *firstPage.NextCursor, 2)
	if err != nil {
		t.Fatalf("second resync page failed: %v", err)
	}
	if len(secondPage.Messages) != 1 || len(secondPage.Calls) != 1 || secondPage.Calls[0].CallID != "call-0" || !secondPage.HasMore || secondPage.NextCursor == nil {
		t.Fatalf("unexpected second page: %+v", secondPage)
	}

	thirdPage, err := state.getResyncPage(nil, *secondPage.NextCursor, 2)
	if err != nil {
		t.Fatalf("third resync page failed: %v", err)
	}
	if len(thirdPage.Messages) != 0 || len(thirdPage.Calls) != 2 || thirdPage.Calls[0].CallID != "call-1" || thirdPage.HasMore || thirdPage.NextCursor != nil {
		t.Fatalf("unexpected third page: %+v", thirdPage)
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

func TestResyncPageUsesStableSnapshotAcrossPages(t *testing.T) {
	storeDir := t.TempDir()
	state, err := newHelperState(storeDir)
	if err != nil {
		t.Fatalf("newHelperState failed: %v", err)
	}
	defer state.close()

	for index := 0; index < 3; index++ {
		state.setMessage(messageSnapshot{
			MessageID: "wamid-base-" + strconv.Itoa(index),
			ChatJID:   "15551234567@s.whatsapp.net",
			Timestamp: int64(index + 1),
			Text:      "base",
		})
	}

	firstPage, err := state.getResyncPage(nil, "", 2)
	if err != nil {
		t.Fatalf("first resync page failed: %v", err)
	}
	if len(firstPage.Messages) != 2 || firstPage.NextCursor == nil || !firstPage.HasMore {
		t.Fatalf("unexpected first page: %+v", firstPage)
	}

	time.Sleep(2 * time.Millisecond)
	state.setMessage(messageSnapshot{
		MessageID: "wamid-late",
		ChatJID:   "15551234567@s.whatsapp.net",
		Timestamp: 1,
		Text:      "late",
	})

	secondPage, err := state.getResyncPage(nil, *firstPage.NextCursor, 2)
	if err != nil {
		t.Fatalf("second resync page failed: %v", err)
	}
	if secondPage.CompletedAt != firstPage.CompletedAt {
		t.Fatalf("expected stable completedAt across pages, got %d then %d", firstPage.CompletedAt, secondPage.CompletedAt)
	}
	if len(secondPage.Messages) != 1 || secondPage.Messages[0].MessageID != "wamid-base-2" {
		t.Fatalf("expected only remaining base message, got %+v", secondPage.Messages)
	}

	incrementalPage, err := state.getResyncPage(&firstPage.CompletedAt, "", 10)
	if err != nil {
		t.Fatalf("incremental resync failed: %v", err)
	}
	if len(incrementalPage.Messages) != 1 || incrementalPage.Messages[0].MessageID != "wamid-late" {
		t.Fatalf("expected late message on next incremental sync, got %+v", incrementalPage.Messages)
	}
}

func TestHistorySyncBatchFromEventUsesHistoryPayload(t *testing.T) {
	event := &events.HistorySync{
		Data: &waHistorySync.HistorySync{
			Pushnames: []*waHistorySync.Pushname{
				{
					ID:       proto.String("15551234567@s.whatsapp.net"),
					Pushname: proto.String("Avery"),
				},
			},
			Conversations: []*waHistorySync.Conversation{
				{
					ID:   proto.String("15551234567@s.whatsapp.net"),
					Name: proto.String("Avery"),
					Messages: []*waHistorySync.HistorySyncMsg{
						{
							Message: &waWeb.WebMessageInfo{
								Key: &waCommon.MessageKey{
									ID:        proto.String("wamid-history"),
									RemoteJID: proto.String("15551234567@s.whatsapp.net"),
									FromMe:    proto.Bool(false),
								},
								MessageTimestamp: proto.Uint64(1_710_000_000),
								PushName:         proto.String("Avery"),
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
	if len(snapshot.Contacts) == 0 || snapshot.Contacts[0].PushName == nil || *snapshot.Contacts[0].PushName != "Avery" {
		t.Fatalf("expected pushname contact in snapshot, got %+v", snapshot.Contacts)
	}
	if len(snapshot.Chats) != 1 || snapshot.Chats[0].JID != "15551234567@s.whatsapp.net" {
		t.Fatalf("expected chat in snapshot, got %+v", snapshot.Chats)
	}
}

func TestHistorySyncBatchFromEventIncludesCallLogRecords(t *testing.T) {
	self := types.NewJID("15550000001", types.DefaultUserServer)
	peer := types.NewJID("15550000002", types.DefaultUserServer)
	when := time.Date(2026, 5, 22, 10, 45, 0, 0, time.UTC)
	result := waSyncAction.CallLogRecord_CONNECTED
	callType := waSyncAction.CallLogRecord_REGULAR
	client := whatsmeow.NewClient(&store.Device{ID: &self}, nil)

	snapshot := historySyncBatchFromEvent(client, &events.HistorySync{
		Data: &waHistorySync.HistorySync{
			CallLogRecords: []*waSyncAction.CallLogRecord{{
				CallID:         proto.String("call-history-1"),
				CallCreatorJID: proto.String(self.String()),
				Participants: []*waSyncAction.CallLogRecord_ParticipantInfo{{
					UserJID: proto.String(peer.String()),
				}},
				CallResult: &result,
				CallType:   &callType,
				Duration:   proto.Int64(61),
				StartTime:  proto.Int64(when.UnixMilli()),
				IsIncoming: proto.Bool(false),
				IsVideo:    proto.Bool(false),
			}},
		},
	})

	if len(snapshot.Calls) != 1 {
		t.Fatalf("expected one call in snapshot, got %+v", snapshot.Calls)
	}
	call := snapshot.Calls[0]
	if call.CallID != "call-history-1" || call.ChatJID != peer.String() || call.Timestamp != when.UnixMilli() {
		t.Fatalf("unexpected call snapshot: %+v", call)
	}
	if !call.FromMe || call.Status != "completed" || call.Medium != "audio" {
		t.Fatalf("unexpected call fields: %+v", call)
	}
	if call.DurationSeconds == nil || *call.DurationSeconds != 61 {
		t.Fatalf("unexpected call duration: %+v", call.DurationSeconds)
	}
	if len(snapshot.Contacts) != 1 || snapshot.Contacts[0].JID != peer.String() {
		t.Fatalf("expected peer contact from call, got %+v", snapshot.Contacts)
	}
	if len(snapshot.Chats) != 1 || snapshot.Chats[0].JID != peer.String() {
		t.Fatalf("expected peer chat from call, got %+v", snapshot.Chats)
	}
}

func TestHistoryMessageSnapshotFallbackRetainsMediaMetadata(t *testing.T) {
	historyMsg := &waHistorySync.HistorySyncMsg{
		Message: &waWeb.WebMessageInfo{
			Key: &waCommon.MessageKey{
				ID:        proto.String("wamid-history-media"),
				RemoteJID: proto.String("15551234567@s.whatsapp.net"),
				FromMe:    proto.Bool(false),
			},
			MessageTimestamp: proto.Uint64(1_710_000_000),
			PushName:         proto.String("Avery"),
			Message: &waProto.Message{
				ImageMessage: &waProto.ImageMessage{
					Mimetype:   proto.String("image/jpeg"),
					FileLength: proto.Uint64(42),
					Caption:    proto.String("photo"),
				},
			},
		},
	}

	snapshot, ok := historyMessageSnapshot(nil, types.NewJID("15551234567", types.DefaultUserServer), historyMsg)
	if !ok {
		t.Fatal("expected fallback history snapshot")
	}
	if snapshot.MessageProto == nil || *snapshot.MessageProto == "" {
		t.Fatalf("expected encoded message proto, got %#v", snapshot.MessageProto)
	}
	if len(snapshot.Attachments) != 1 {
		t.Fatalf("expected one attachment, got %+v", snapshot.Attachments)
	}
	if snapshot.Attachments[0].Kind != "image" {
		t.Fatalf("expected image attachment, got %+v", snapshot.Attachments[0])
	}
}

func TestHistoryMessageSnapshotFallbackNamesDocumentFromMimeType(t *testing.T) {
	historyMsg := &waHistorySync.HistorySyncMsg{
		Message: &waWeb.WebMessageInfo{
			Key: &waCommon.MessageKey{
				ID:        proto.String("wamid-history-doc"),
				RemoteJID: proto.String("15551234567@s.whatsapp.net"),
				FromMe:    proto.Bool(false),
			},
			MessageTimestamp: proto.Uint64(1_710_000_000),
			Message: &waProto.Message{
				DocumentMessage: &waProto.DocumentMessage{
					Mimetype:   proto.String("application/pdf"),
					FileLength: proto.Uint64(42),
					Caption:    proto.String("agenda"),
				},
			},
		},
	}

	snapshot, ok := historyMessageSnapshot(nil, types.NewJID("15551234567", types.DefaultUserServer), historyMsg)
	if !ok {
		t.Fatal("expected fallback history snapshot")
	}
	if len(snapshot.Attachments) != 1 {
		t.Fatalf("expected one attachment, got %+v", snapshot.Attachments)
	}
	if snapshot.Attachments[0].Filename == nil || *snapshot.Attachments[0].Filename != "file.pdf" {
		t.Fatalf("expected MIME-aware document filename, got %+v", snapshot.Attachments[0])
	}
}

func TestHistoryMessageSnapshotFallbackUnwrapsEditedMessageText(t *testing.T) {
	historyMsg := &waHistorySync.HistorySyncMsg{
		Message: &waWeb.WebMessageInfo{
			Key: &waCommon.MessageKey{
				ID:        proto.String("wamid-edited"),
				RemoteJID: proto.String("15551234567@s.whatsapp.net"),
				FromMe:    proto.Bool(false),
			},
			MessageTimestamp: proto.Uint64(123),
			Message: &waProto.Message{
				ProtocolMessage: &waProto.ProtocolMessage{
					Type: waProto.ProtocolMessage_MESSAGE_EDIT.Enum(),
					EditedMessage: &waProto.Message{
						Conversation: proto.String("edited body"),
					},
				},
			},
		},
	}

	snapshot, ok := historyMessageSnapshot(nil, types.NewJID("15551234567", types.DefaultUserServer), historyMsg)
	if !ok {
		t.Fatal("expected edited history snapshot")
	}
	if snapshot.Text != "edited body" {
		t.Fatalf("expected edited text, got %q", snapshot.Text)
	}
}

func TestHistoryMessageSnapshotFallbackSkipsEncryptedWrappersWithoutClient(t *testing.T) {
	historyMsg := &waHistorySync.HistorySyncMsg{
		Message: &waWeb.WebMessageInfo{
			Key: &waCommon.MessageKey{
				ID:        proto.String("wamid-secret-edit"),
				RemoteJID: proto.String("15551234567@s.whatsapp.net"),
				FromMe:    proto.Bool(false),
			},
			MessageTimestamp: proto.Uint64(123),
			Message: &waProto.Message{
				SecretEncryptedMessage: &waProto.SecretEncryptedMessage{
					SecretEncType: waE2E.SecretEncryptedMessage_MESSAGE_EDIT.Enum(),
					TargetMessageKey: &waCommon.MessageKey{
						ID:        proto.String("wamid-original"),
						RemoteJID: proto.String("15551234567@s.whatsapp.net"),
						FromMe:    proto.Bool(false),
					},
					EncPayload: []byte("ciphertext"),
					EncIV:      []byte("nonce"),
				},
			},
		},
	}

	if snapshot, ok := historyMessageSnapshot(nil, types.NewJID("15551234567", types.DefaultUserServer), historyMsg); ok {
		t.Fatalf("expected encrypted wrapper to be skipped without a decrypting client, got %+v", snapshot)
	}
}

func TestPrepareMessageEventForReadSkipsEncryptedWrappersWithoutClient(t *testing.T) {
	event := &events.Message{
		Info: types.MessageInfo{
			ID: "wamid-secret-edit",
			MessageSource: types.MessageSource{
				Chat:   types.NewJID("15551234567", types.DefaultUserServer),
				Sender: types.NewJID("15551234567", types.DefaultUserServer),
			},
		},
		Message: &waProto.Message{
			SecretEncryptedMessage: &waProto.SecretEncryptedMessage{
				SecretEncType: waE2E.SecretEncryptedMessage_MESSAGE_EDIT.Enum(),
				TargetMessageKey: &waCommon.MessageKey{
					ID:        proto.String("wamid-original"),
					RemoteJID: proto.String("15551234567@s.whatsapp.net"),
					FromMe:    proto.Bool(false),
				},
				EncPayload: []byte("ciphertext"),
				EncIV:      []byte("nonce"),
			},
		},
	}

	if prepareMessageEventForRead(context.Background(), nil, event) {
		t.Fatal("expected encrypted wrapper without a client to be skipped")
	}
}

func TestExtractTextUnwrapsFutureProofEditedMessage(t *testing.T) {
	message := &waProto.Message{
		EditedMessage: &waProto.FutureProofMessage{
			Message: &waProto.Message{
				ExtendedTextMessage: &waProto.ExtendedTextMessage{
					Text: proto.String("future proof edit"),
				},
			},
		},
	}

	if got := extractText(message); got != "future proof edit" {
		t.Fatalf("expected future-proof edited text, got %q", got)
	}
}

func TestHistoryMessageSnapshotFallbackRetainsRevokeMetadata(t *testing.T) {
	revokeType := waProto.ProtocolMessage_REVOKE
	revokeSnapshot, ok := historyMessageSnapshot(nil, types.NewJID("15551234567", types.DefaultUserServer), &waHistorySync.HistorySyncMsg{
		Message: &waWeb.WebMessageInfo{
			Key: &waCommon.MessageKey{
				ID:        proto.String("wamid-revoke"),
				RemoteJID: proto.String("15551234567@s.whatsapp.net"),
				FromMe:    proto.Bool(true),
			},
			MessageTimestamp: proto.Uint64(1_710_000_001),
			Message: &waProto.Message{
				ProtocolMessage: &waProto.ProtocolMessage{
					Type: &revokeType,
					Key: &waCommon.MessageKey{
						ID:        proto.String("wamid-revoked"),
						RemoteJID: proto.String("15551234567@s.whatsapp.net"),
						FromMe:    proto.Bool(true),
					},
				},
			},
		},
	})
	if !ok {
		t.Fatal("expected revoke fallback history snapshot")
	}
	if !revokeSnapshot.Revoked {
		t.Fatalf("expected revoked metadata, got %+v", revokeSnapshot)
	}
	if revokeSnapshot.MessageID != "wamid-revoked" {
		t.Fatalf("expected revoke to target original message id, got %+v", revokeSnapshot)
	}
}

func TestMessageFromEventUsesDeviceSentDestinationChat(t *testing.T) {
	destination := "15551234567@s.whatsapp.net"
	event := &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{
				Chat:     types.NewJID("15550000000", types.DefaultUserServer),
				Sender:   types.NewJID("15550000000", types.DefaultUserServer),
				IsFromMe: true,
			},
			ID:        "wamid-device-sent",
			Timestamp: time.Unix(1_710_000_000, 0).UTC(),
			DeviceSentMeta: &types.DeviceSentMeta{
				DestinationJID: destination,
			},
		},
		Message: &waProto.Message{
			DeviceSentMessage: &waProto.DeviceSentMessage{
				DestinationJID: proto.String(destination),
				Message: &waProto.Message{
					Conversation: proto.String("sent from phone"),
				},
			},
		},
	}

	snapshot := messageFromEvent(event)
	if snapshot.ChatJID != destination {
		t.Fatalf("expected device-sent destination chat, got %+v", snapshot)
	}
	if !snapshot.FromMe || snapshot.Text != "sent from phone" {
		t.Fatalf("unexpected device-sent snapshot: %+v", snapshot)
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

func TestConfigureClientPayloadMatchesWebDesktopCompanion(t *testing.T) {
	configureClientPayload()

	if store.DeviceProps.GetRequireFullSync() != false {
		t.Fatalf("expected helper to use the default bootstrap history request")
	}

	config := store.DeviceProps.GetHistorySyncConfig()
	if config == nil {
		t.Fatalf("expected history sync config to be configured")
	}
	if got := config.GetSupportGroupHistory(); got != true {
		t.Fatalf("expected group history support to be enabled")
	}
	if got := config.GetSupportCallLogHistory(); got != true {
		t.Fatalf("expected call log history support to be enabled")
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
	if got := store.BaseClientPayload.GetUserAgent().GetPlatform(); got != waWa6.ClientPayload_UserAgent_WEB {
		t.Fatalf("unexpected user agent platform: %v", got)
	}
	if got := store.BaseClientPayload.GetWebInfo().GetWebSubPlatform(); got != waWa6.ClientPayload_WebInfo_WEB_BROWSER {
		t.Fatalf("unexpected web sub-platform: %v", got)
	}
}

func TestOpenSyncCacheMigratesLegacyMessageColumns(t *testing.T) {
	storeDir := t.TempDir()
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s", filepath.Join(storeDir, "history.db")))
	if err != nil {
		t.Fatalf("open legacy cache db: %v", err)
	}
	_, err = db.Exec(`CREATE TABLE messages (
		chat_jid TEXT NOT NULL,
		message_id TEXT NOT NULL,
		sender_jid TEXT,
		participant_jid TEXT,
		from_me INTEGER NOT NULL,
		timestamp INTEGER NOT NULL,
		text TEXT NOT NULL,
		push_name TEXT,
		status TEXT,
		delivered_at INTEGER,
		read_at INTEGER,
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (chat_jid, message_id)
	)`)
	if err != nil {
		t.Fatalf("create legacy messages table: %v", err)
	}
	_, err = db.Exec(
		`INSERT INTO messages (
			chat_jid, message_id, sender_jid, from_me, timestamp, text, status, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		"15551234567@s.whatsapp.net",
		"wamid-legacy",
		"15551234567@s.whatsapp.net",
		0,
		1_710_000_000_000,
		"legacy",
		"delivered",
		1_710_000_000_001,
	)
	if err != nil {
		t.Fatalf("insert legacy message: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close legacy cache db: %v", err)
	}

	cache, err := openSyncCache(storeDir)
	if err != nil {
		t.Fatalf("openSyncCache should migrate legacy schema: %v", err)
	}
	defer cache.close()

	for _, column := range []string{"revoked"} {
		if !sqliteColumnExists(t, cache.db, "messages", column) {
			t.Fatalf("expected migrated messages.%s column", column)
		}
	}

	messages, _, _, err := cache.queryMessages(nil, &resyncCursor{SnapshotUpdatedAt: 1_710_000_000_001}, 10)
	if err != nil {
		t.Fatalf("query migrated legacy messages: %v", err)
	}
	if len(messages) != 1 {
		t.Fatalf("expected legacy message to remain queryable, got %+v", messages)
	}
	if messages[0].Revoked {
		t.Fatalf("expected legacy message revoked default to be false, got %+v", messages[0])
	}
}

func sqliteColumnExists(t *testing.T, db *sql.DB, table string, column string) bool {
	t.Helper()
	rows, err := db.Query(fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		t.Fatalf("inspect %s columns: %v", table, err)
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name string
		var columnType string
		var notNull int
		var defaultValue sql.NullString
		var primaryKey int
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			t.Fatalf("scan %s column info: %v", table, err)
		}
		if name == column {
			return true
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate %s column info: %v", table, err)
	}
	return false
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

func TestApplyHistorySyncDataPersistsCallLogRecords(t *testing.T) {
	storeDir := t.TempDir()
	state, err := newHelperState(storeDir)
	if err != nil {
		t.Fatalf("newHelperState failed: %v", err)
	}
	defer state.close()

	self := types.NewJID("15550000001", types.DefaultUserServer)
	peer := types.NewJID("15550000002", types.DefaultUserServer)
	when := time.Date(2026, 5, 22, 10, 45, 0, 0, time.UTC)
	result := waSyncAction.CallLogRecord_MISSED
	callType := waSyncAction.CallLogRecord_REGULAR
	client := whatsmeow.NewClient(&store.Device{ID: &self}, nil)
	runtime := newHelperRuntime(client, state, json.NewEncoder(io.Discard))

	err = runtime.applyHistorySyncData(&waHistorySync.HistorySync{
		SyncType: waHistorySync.HistorySync_FULL.Enum(),
		CallLogRecords: []*waSyncAction.CallLogRecord{{
			CallID:         proto.String("call-apply-1"),
			CallCreatorJID: proto.String(peer.String()),
			Participants: []*waSyncAction.CallLogRecord_ParticipantInfo{{
				UserJID: proto.String(self.String()),
			}},
			CallResult: &result,
			CallType:   &callType,
			StartTime:  proto.Int64(when.Unix()),
			IsIncoming: proto.Bool(true),
			IsVideo:    proto.Bool(true),
		}},
	})
	if err != nil {
		t.Fatalf("applyHistorySyncData failed: %v", err)
	}

	page, err := state.getResyncPage(nil, "", 100)
	if err != nil {
		t.Fatalf("getResyncPage failed: %v", err)
	}
	if len(page.Calls) != 1 {
		t.Fatalf("expected one persisted call, got %+v", page.Calls)
	}
	call := page.Calls[0]
	if call.CallID != "call-apply-1" || call.ChatJID != peer.String() || call.Timestamp != when.UnixMilli() {
		t.Fatalf("unexpected persisted call: %+v", call)
	}
	if call.FromMe || call.Status != "missed" || call.Medium != "video" {
		t.Fatalf("unexpected persisted call fields: %+v", call)
	}
}

func TestHandleAppStateEventDeletesPeerCallLogRecords(t *testing.T) {
	storeDir := t.TempDir()
	state, err := newHelperState(storeDir)
	if err != nil {
		t.Fatalf("newHelperState failed: %v", err)
	}
	defer state.close()

	self := types.NewJID("15550000001", types.DefaultUserServer)
	peer := types.NewJID("15550000002", types.DefaultUserServer)
	when := time.Date(2026, 5, 22, 10, 45, 0, 0, time.UTC)
	result := waSyncAction.CallLogRecord_CONNECTED
	callType := waSyncAction.CallLogRecord_REGULAR
	client := whatsmeow.NewClient(&store.Device{ID: &self}, nil)
	runtime := newHelperRuntime(client, state, json.NewEncoder(io.Discard))

	runtime.handleAppStateEvent(&events.AppState{
		SyncActionValue: &waSyncAction.SyncActionValue{
			Timestamp: proto.Int64(when.UnixMilli()),
			CallLogAction: &waSyncAction.CallLogAction{
				CallLogRecord: &waSyncAction.CallLogRecord{
					CallID:         proto.String("call-delete-1"),
					CallCreatorJID: proto.String(self.String()),
					Participants: []*waSyncAction.CallLogRecord_ParticipantInfo{{
						UserJID: proto.String(peer.String()),
					}},
					CallResult: &result,
					CallType:   &callType,
					StartTime:  proto.Int64(when.UnixMilli()),
					IsIncoming: proto.Bool(false),
					IsVideo:    proto.Bool(false),
				},
			},
		},
	})

	page, err := state.getResyncPage(nil, "", 100)
	if err != nil {
		t.Fatalf("getResyncPage after upsert failed: %v", err)
	}
	if len(page.Calls) != 1 || page.Calls[0].CallID != "call-delete-1" {
		t.Fatalf("expected one app-state call before delete, got %+v", page.Calls)
	}

	runtime.handleAppStateEvent(&events.AppState{
		SyncActionValue: &waSyncAction.SyncActionValue{
			DeleteIndividualCallLog: &waSyncAction.DeleteIndividualCallLogAction{
				PeerJID:    proto.String(peer.String()),
				IsIncoming: proto.Bool(false),
			},
		},
	})

	page, err = state.getResyncPage(nil, "", 100)
	if err != nil {
		t.Fatalf("getResyncPage after delete failed: %v", err)
	}
	if len(page.Calls) != 0 {
		t.Fatalf("expected peer call log delete to remove outbound calls, got %+v", page.Calls)
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
		PushName: "Avery Example",
		ID: &types.JID{
			User:   "15550101000",
			Server: types.DefaultUserServer,
		},
	}, nil)
	runtime := newHelperRuntime(client, state, json.NewEncoder(io.Discard))
	runtime.handleEvent(&events.Connected{})

	metadata := state.getMetadata()
	if metadata.AccountJID != "15550101000@s.whatsapp.net" {
		t.Fatalf("unexpected account jid: %q", metadata.AccountJID)
	}
	if metadata.LastHistorySyncAt != 123 || metadata.LastHistorySyncType != "FULL" {
		t.Fatalf("expected history sync metadata to survive connect, got %+v", metadata)
	}
	if metadata.LastHistoryChunkOrder != 2 || metadata.LastHistoryProgress != 100 {
		t.Fatalf("expected history sync chunk/progress to survive connect, got %+v", metadata)
	}
}

func TestConnectedEventClearsHistorySyncMetadataForChangedDevice(t *testing.T) {
	storeDir := t.TempDir()
	state, err := newHelperState(storeDir)
	if err != nil {
		t.Fatalf("newHelperState failed: %v", err)
	}
	defer state.close()

	state.setMetadata(helperMetadata{
		AccountJID:                "15550101000@s.whatsapp.net",
		LastHistorySyncAt:         123,
		LastHistorySyncType:       "FULL",
		LastHistoryChunkOrder:     2,
		LastHistoryProgress:       100,
		LastHistorySyncError:      "old error",
		LastHistoryNotificationAt: 122,
	})

	client := whatsmeow.NewClient(&store.Device{
		PushName: "Avery Example",
		ID: &types.JID{
			User:   "15550101000:2",
			Server: types.DefaultUserServer,
		},
	}, nil)
	runtime := newHelperRuntime(client, state, json.NewEncoder(io.Discard))
	runtime.handleEvent(&events.Connected{})

	metadata := state.getMetadata()
	if metadata.AccountJID != "15550101000:2@s.whatsapp.net" {
		t.Fatalf("unexpected account jid: %q", metadata.AccountJID)
	}
	if metadata.LastHistorySyncAt != 0 || metadata.LastHistorySyncType != "" {
		t.Fatalf("expected changed device to clear stale history metadata, got %+v", metadata)
	}
	if metadata.LastHistoryChunkOrder != 0 || metadata.LastHistoryProgress != 0 {
		t.Fatalf("expected changed device to clear chunk/progress, got %+v", metadata)
	}
	if metadata.LastHistorySyncError != "" || metadata.LastHistoryNotificationAt != 0 {
		t.Fatalf("expected changed device to clear history error/notification, got %+v", metadata)
	}
}

func TestHelperStateRetainsDownloadableMediaAcrossReload(t *testing.T) {
	state, err := newHelperState(t.TempDir())
	if err != nil {
		t.Fatalf("newHelperState: %v", err)
	}
	defer state.close()

	protoValue := "encoded-message"
	for index := range 5001 {
		message := messageSnapshot{
			MessageID: fmt.Sprintf("message-%d", index),
			ChatJID:   "12015550123@s.whatsapp.net",
			Text:      "hello",
		}
		if index == 0 {
			message.MessageProto = &protoValue
			message.Attachments = []attachmentSnapshot{{
				ID:         "attachment-0",
				Kind:       "image",
				AccessKind: "provider_fetch",
			}}
		}
		state.setMessage(message)
	}

	if message := state.findMessage("12015550123@s.whatsapp.net", "message-0"); message == nil {
		t.Fatal("downloadable media metadata was not retained")
	} else if message.MessageProto == nil || *message.MessageProto != protoValue {
		t.Fatalf("unexpected proto for retained media message: %#v", message.MessageProto)
	}
	if message := state.findMessage(" 12015550123@S.WHATSAPP.NET ", "message-0"); message == nil {
		t.Fatal("downloadable media lookup did not normalize chat JID")
	}

	reloaded, err := newHelperState(state.storeDir)
	if err != nil {
		t.Fatalf("reload helper state: %v", err)
	}
	defer reloaded.close()

	if message := reloaded.findMessage("12015550123@s.whatsapp.net", "message-0"); message == nil {
		t.Fatal("reloaded helper state lost downloadable media metadata")
	} else if len(message.Attachments) != 1 {
		t.Fatalf("reloaded helper state kept %d attachments, want 1", len(message.Attachments))
	}
}

func TestApplySnapshotDoesNotRewriteUnchangedMediaFile(t *testing.T) {
	state, err := newHelperState(t.TempDir())
	if err != nil {
		t.Fatalf("newHelperState: %v", err)
	}
	defer state.close()

	protoValue := "encoded-message"
	snapshot := stateSnapshot{
		Messages: []messageSnapshot{
			{
				MessageID:    "message-1",
				ChatJID:      "12015550123@s.whatsapp.net",
				MessageProto: &protoValue,
				Attachments: []attachmentSnapshot{{
					ID:         "attachment-1",
					Kind:       "image",
					AccessKind: "provider_fetch",
					AccessRef: map[string]interface{}{
						"chatJID":         "12015550123@s.whatsapp.net",
						"messageID":       "message-1",
						"attachmentIndex": 0,
					},
				}},
			},
			{
				MessageID:    "message-2",
				ChatJID:      "12015550123@s.whatsapp.net",
				MessageProto: &protoValue,
				Attachments: []attachmentSnapshot{{
					ID:         "attachment-2",
					Kind:       "document",
					AccessKind: "provider_fetch",
					AccessRef: map[string]interface{}{
						"chatJID":         "12015550123@s.whatsapp.net",
						"messageID":       "message-2",
						"attachmentIndex": 0,
					},
				}},
			},
		},
	}

	if err := state.applySnapshot(snapshot); err != nil {
		t.Fatalf("applySnapshot first pass: %v", err)
	}

	infoBefore, err := os.Stat(state.mediaPath)
	if err != nil {
		t.Fatalf("stat media file after first apply: %v", err)
	}

	time.Sleep(20 * time.Millisecond)

	if err := state.applySnapshot(snapshot); err != nil {
		t.Fatalf("applySnapshot second pass: %v", err)
	}

	infoAfter, err := os.Stat(state.mediaPath)
	if err != nil {
		t.Fatalf("stat media file after second apply: %v", err)
	}
	if !infoAfter.ModTime().Equal(infoBefore.ModTime()) {
		t.Fatalf("expected unchanged media snapshot to avoid rewrite, mod time changed from %v to %v", infoBefore.ModTime(), infoAfter.ModTime())
	}
}

func TestApplySnapshotDoesNotRewriteUnchangedMediaFileAfterReload(t *testing.T) {
	state, err := newHelperState(t.TempDir())
	if err != nil {
		t.Fatalf("newHelperState: %v", err)
	}

	protoValue := "encoded-message"
	snapshot := stateSnapshot{
		Messages: []messageSnapshot{
			{
				MessageID:    "message-1",
				ChatJID:      "12015550123@s.whatsapp.net",
				MessageProto: &protoValue,
				Attachments: []attachmentSnapshot{{
					ID:         "attachment-1",
					Kind:       "image",
					AccessKind: "provider_fetch",
					AccessRef: map[string]interface{}{
						"chatJID":         "12015550123@s.whatsapp.net",
						"messageID":       "message-1",
						"attachmentIndex": 0,
					},
				}},
			},
		},
	}

	if err := state.applySnapshot(snapshot); err != nil {
		t.Fatalf("applySnapshot first pass: %v", err)
	}

	infoBefore, err := os.Stat(state.mediaPath)
	if err != nil {
		t.Fatalf("stat media file after first apply: %v", err)
	}

	storeDir := state.storeDir
	if err := state.close(); err != nil {
		t.Fatalf("close helper state: %v", err)
	}

	time.Sleep(20 * time.Millisecond)

	reloaded, err := newHelperState(storeDir)
	if err != nil {
		t.Fatalf("reload helper state: %v", err)
	}
	defer reloaded.close()

	if err := reloaded.applySnapshot(snapshot); err != nil {
		t.Fatalf("applySnapshot after reload: %v", err)
	}

	infoAfter, err := os.Stat(reloaded.mediaPath)
	if err != nil {
		t.Fatalf("stat media file after reload apply: %v", err)
	}
	if !infoAfter.ModTime().Equal(infoBefore.ModTime()) {
		t.Fatalf("expected unchanged media snapshot after reload to avoid rewrite, mod time changed from %v to %v", infoBefore.ModTime(), infoAfter.ModTime())
	}
}
