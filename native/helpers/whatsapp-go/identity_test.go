package main

import (
	"bytes"
	"context"
	"encoding/json"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"math"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

func TestIdentityAliasesUsePersistentProviderMappings(t *testing.T) {
	dir := t.TempDir()
	state, client, cleanup, err := initClient(dir)
	if err != nil {
		t.Fatal(err)
	}
	client.Store.LIDs = client.Store.Container.(*sqlstore.Container).LIDMap
	lid := types.NewJID("123456", types.HiddenUserServer)
	pn := types.NewJID("15551234567", types.DefaultUserServer)
	if err = client.Store.LIDs.PutLIDMapping(context.Background(), lid, pn); err != nil {
		t.Fatal(err)
	}
	runtime := newHelperRuntime(client, state, nil)
	aliases := runtime.identityAliases(messageSnapshot{ChatJID: lid.String(), SenderJID: stringPtr(pn.String())})
	if len(aliases) != 1 || aliases[0].PN != pn.String() || aliases[0].LID != lid.String() {
		t.Fatalf("unexpected aliases: %+v", aliases)
	}
	if err := runtime.storeHistoryIdentityAliases(&waHistorySync.HistorySync{Conversations: []*waHistorySync.Conversation{{ID: proto.String("456@lid"), PnJID: proto.String("15559999999@s.whatsapp.net")}}}); err != nil {
		t.Fatal(err)
	}
	state.setChat(chatSnapshot{JID: "456@lid"})
	cleanup()
	state, client, cleanup, err = initClient(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	client.Store.LIDs = client.Store.Container.(*sqlstore.Container).LIDMap
	runtime = newHelperRuntime(client, state, nil)
	cached, err := runtime.cachedIdentityAliases()
	if err != nil || len(cached) != 1 || cached[0].LID != "456@lid" || cached[0].PN != "15559999999@s.whatsapp.net" {
		t.Fatalf("history alias not persisted for incremental migration: %+v %v", cached, err)
	}
	aliases = runtime.identityAliases(resyncPage{Chats: []chatSnapshot{{JID: lid.String()}, {JID: "999@lid"}, {JID: "15551234567@g.us"}}})
	if len(aliases) != 1 || aliases[0].PN != pn.String() {
		t.Fatalf("persistent mapping lost or fabricated: %+v", aliases)
	}
}

func TestPairingRequiresUploadedPrekeys(t *testing.T) {
	runtime := newHelperRuntime(whatsmeow.NewClient(&store.Device{}, nil), nil, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if err := waitForPairPreKeys(ctx, runtime); err == nil {
		t.Fatal("pairing succeeded before keys uploaded")
	}
	runtime.client.PreKeysUploaded.Set()
	if err := waitForPairPreKeys(context.Background(), runtime); err != nil {
		t.Fatal(err)
	}
}

func TestHistoryTimestampValidation(t *testing.T) {
	for _, invalid := range []uint64{0, 1710000000000, math.MaxUint64, 253402300800} {
		_, ok := historyMessageSnapshot(nil, types.NewJID("123", types.HiddenUserServer), &waHistorySync.HistorySyncMsg{Message: &waWeb.WebMessageInfo{MessageTimestamp: proto.Uint64(invalid), Key: &waCommon.MessageKey{ID: proto.String("invalid")}}})
		if ok {
			t.Fatalf("imported malformed timestamp %d", invalid)
		}
	}
	if !validHistoryTimestamp(1710000000) {
		t.Fatal("rejected seconds timestamp")
	}
}

func TestRevokedMessageSurvivesDelayedResendAndRestart(t *testing.T) {
	dir := t.TempDir()
	state, err := newHelperState(dir)
	if err != nil {
		t.Fatal(err)
	}
	revoked := messageSnapshot{ChatJID: "123@lid", MessageID: "same", Timestamp: 1000, Revoked: true}
	if err = state.cache.upsertMessage(revoked); err != nil {
		t.Fatal(err)
	}
	delayed := revoked
	delayed.Revoked = false
	delayed.Text = "deleted secret"
	if err = state.cache.upsertMessage(delayed); err != nil {
		t.Fatal(err)
	}
	state.close()
	state, err = newHelperState(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer state.close()
	snapshot, err := state.cache.getSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Messages) != 1 || !snapshot.Messages[0].Revoked || snapshot.Messages[0].Text != "" {
		t.Fatalf("resurrected message: %+v", snapshot.Messages)
	}
}

func TestHistoryEmissionDoesNotResurrectRevokedMessage(t *testing.T) {
	state, err := newHelperState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer state.close()
	if err := state.cache.upsertMessage(messageSnapshot{ChatJID: "123@lid", MessageID: "deleted", Timestamp: 1000, Revoked: true}); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	runtime := newHelperRuntime(nil, state, json.NewEncoder(&output))
	err = runtime.applyHistorySyncData(&waHistorySync.HistorySync{Conversations: []*waHistorySync.Conversation{{ID: proto.String("123@lid"), Messages: []*waHistorySync.HistorySyncMsg{{Message: &waWeb.WebMessageInfo{Key: &waCommon.MessageKey{ID: proto.String("deleted")}, MessageTimestamp: proto.Uint64(1710000000), Message: &waE2E.Message{Conversation: proto.String("deleted secret")}}}}}}})
	if err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		Event string        `json:"event"`
		Data  stateSnapshot `json:"data"`
	}
	if err := json.Unmarshal(output.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Event != "history_sync" || len(envelope.Data.Messages) != 0 {
		t.Fatalf("emitted revoked original: %s", output.String())
	}
}
