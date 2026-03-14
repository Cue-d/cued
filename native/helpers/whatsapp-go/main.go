package main

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "modernc.org/sqlite"

	waProto "go.mau.fi/whatsmeow/binary/proto"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCompanionReg"
	"go.mau.fi/whatsmeow/proto/waWa6"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

const helperVersion = "0.1.0"

type helperMetadata struct {
	AccountJID string `json:"accountJid,omitempty"`
	PushName   string `json:"pushName,omitempty"`
}

type contactSnapshot struct {
	JID      string  `json:"jid"`
	Phone    *string `json:"phone,omitempty"`
	Name     *string `json:"name,omitempty"`
	PushName *string `json:"pushName,omitempty"`
}

type chatSnapshot struct {
	JID          string   `json:"jid"`
	Name         *string  `json:"name,omitempty"`
	IsGroup      bool     `json:"isGroup"`
	Participants []string `json:"participants,omitempty"`
}

type attachmentSnapshot struct {
	ID              string                 `json:"id"`
	Kind            string                 `json:"kind"`
	Filename        *string                `json:"filename,omitempty"`
	MimeType        *string                `json:"mime_type,omitempty"`
	SizeBytes       *int64                 `json:"size_bytes,omitempty"`
	Text            *string                `json:"text,omitempty"`
	AccessKind      string                 `json:"access_kind"`
	AccessRef       map[string]interface{} `json:"access_ref,omitempty"`
	Availability    string                 `json:"availability_status,omitempty"`
	ProviderMeta    map[string]interface{} `json:"provider_metadata,omitempty"`
}

type messageSnapshot struct {
	MessageID      string  `json:"messageID"`
	ChatJID        string  `json:"chatJID"`
	SenderJID      *string `json:"senderJID,omitempty"`
	ParticipantJID *string `json:"participantJID,omitempty"`
	FromMe         bool    `json:"fromMe"`
	Timestamp      int64   `json:"timestamp"`
	Text           string  `json:"text"`
	PushName       *string `json:"pushName,omitempty"`
	Status         *string `json:"status,omitempty"`
	DeliveredAt    *int64  `json:"deliveredAt,omitempty"`
	ReadAt         *int64  `json:"readAt,omitempty"`
	MessageProto   *string `json:"messageProtoBase64,omitempty"`
	Attachments    []attachmentSnapshot `json:"attachments,omitempty"`
}

type receiptSnapshot struct {
	MessageID   string  `json:"messageID"`
	ChatJID     string  `json:"chatJID"`
	FromMe      bool    `json:"fromMe"`
	Status      *string `json:"status,omitempty"`
	DeliveredAt *int64  `json:"deliveredAt,omitempty"`
	ReadAt      *int64  `json:"readAt,omitempty"`
}

type stateSnapshot struct {
	Contacts []contactSnapshot `json:"contacts,omitempty"`
	Chats    []chatSnapshot    `json:"chats,omitempty"`
	Messages []messageSnapshot `json:"messages,omitempty"`
}

type responseEnvelope struct {
	ID     int         `json:"id"`
	OK     bool        `json:"ok"`
	Result interface{} `json:"result,omitempty"`
	Error  string      `json:"error,omitempty"`
}

type eventEnvelope struct {
	Event string      `json:"event"`
	Data  interface{} `json:"data"`
}

type commandEnvelope struct {
	ID              int    `json:"id"`
	Command         string `json:"command"`
	Target          string `json:"target,omitempty"`
	Text            string `json:"text,omitempty"`
	ChatJID         string `json:"chatJID,omitempty"`
	MessageID       string `json:"messageID,omitempty"`
	AttachmentIndex int    `json:"attachmentIndex,omitempty"`
}

type helperState struct {
	storeDir     string
	metadataPath string
	snapshotPath string

	mu       sync.Mutex
	metadata helperMetadata
	snapshot stateSnapshot
}

func newHelperState(storeDir string) (*helperState, error) {
	if err := os.MkdirAll(storeDir, 0o700); err != nil {
		return nil, err
	}
	state := &helperState{
		storeDir:     storeDir,
		metadataPath: filepath.Join(storeDir, "metadata.json"),
		snapshotPath: filepath.Join(storeDir, "snapshot.json"),
	}
	state.load()
	return state, nil
}

func (s *helperState) load() {
	s.mu.Lock()
	defer s.mu.Unlock()
	readJSONFile(s.metadataPath, &s.metadata)
	readJSONFile(s.snapshotPath, &s.snapshot)
}

func (s *helperState) setMetadata(metadata helperMetadata) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.metadata = metadata
	_ = writeJSONFileAtomic(s.metadataPath, s.metadata)
}

func (s *helperState) getMetadata() helperMetadata {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.metadata
}

func (s *helperState) setContact(contact contactSnapshot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	replaced := false
	for idx, existing := range s.snapshot.Contacts {
		if normalizeJID(existing.JID) == normalizeJID(contact.JID) {
			s.snapshot.Contacts[idx] = contact
			replaced = true
			break
		}
	}
	if !replaced {
		s.snapshot.Contacts = append(s.snapshot.Contacts, contact)
	}
	_ = writeJSONFileAtomic(s.snapshotPath, s.snapshot)
}

func (s *helperState) setChat(chat chatSnapshot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	replaced := false
	for idx, existing := range s.snapshot.Chats {
		if normalizeJID(existing.JID) == normalizeJID(chat.JID) {
			s.snapshot.Chats[idx] = chat
			replaced = true
			break
		}
	}
	if !replaced {
		s.snapshot.Chats = append(s.snapshot.Chats, chat)
	}
	_ = writeJSONFileAtomic(s.snapshotPath, s.snapshot)
}

func (s *helperState) setMessage(message messageSnapshot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	replaced := false
	for idx, existing := range s.snapshot.Messages {
		if normalizeJID(existing.ChatJID) == normalizeJID(message.ChatJID) && existing.MessageID == message.MessageID {
			s.snapshot.Messages[idx] = message
			replaced = true
			break
		}
	}
	if !replaced {
		s.snapshot.Messages = append(s.snapshot.Messages, message)
	}
	if len(s.snapshot.Messages) > 5000 {
		s.snapshot.Messages = s.snapshot.Messages[len(s.snapshot.Messages)-5000:]
	}
	_ = writeJSONFileAtomic(s.snapshotPath, s.snapshot)
}

func (s *helperState) applyReceipt(receipt receiptSnapshot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for idx, message := range s.snapshot.Messages {
		if normalizeJID(message.ChatJID) != normalizeJID(receipt.ChatJID) || message.MessageID != receipt.MessageID {
			continue
		}
		if receipt.Status != nil {
			message.Status = receipt.Status
		}
		if receipt.DeliveredAt != nil {
			message.DeliveredAt = receipt.DeliveredAt
		}
		if receipt.ReadAt != nil {
			message.ReadAt = receipt.ReadAt
		}
		s.snapshot.Messages[idx] = message
		break
	}
	_ = writeJSONFileAtomic(s.snapshotPath, s.snapshot)
}

func (s *helperState) getSnapshot() stateSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.snapshot
}

func (s *helperState) findMessage(chatJID string, messageID string) *messageSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	normalizedChat := normalizeJID(chatJID)
	for _, message := range s.snapshot.Messages {
		if normalizeJID(message.ChatJID) == normalizedChat && message.MessageID == messageID {
			copy := message
			return &copy
		}
	}
	return nil
}

type helperRuntime struct {
	client     *whatsmeow.Client
	state      *helperState
	connected  bool
	connectedM sync.RWMutex
	writer     *json.Encoder
	writerM    sync.Mutex
}

func newHelperRuntime(client *whatsmeow.Client, state *helperState, writer *json.Encoder) *helperRuntime {
	return &helperRuntime{
		client: client,
		state:  state,
		writer: writer,
	}
}

func (r *helperRuntime) emitEvent(name string, data interface{}) {
	r.writerM.Lock()
	defer r.writerM.Unlock()
	_ = r.writer.Encode(eventEnvelope{
		Event: name,
		Data:  data,
	})
}

func (r *helperRuntime) writeResponse(id int, ok bool, result interface{}, err error) {
	r.writerM.Lock()
	defer r.writerM.Unlock()
	response := responseEnvelope{
		ID: id,
		OK: ok,
	}
	if err != nil {
		response.Error = err.Error()
	} else {
		response.Result = result
	}
	_ = r.writer.Encode(response)
}

func (r *helperRuntime) setConnected(value bool) {
	r.connectedM.Lock()
	defer r.connectedM.Unlock()
	r.connected = value
}

func (r *helperRuntime) isConnected() bool {
	r.connectedM.RLock()
	defer r.connectedM.RUnlock()
	return r.connected
}

func main() {
	log.SetFlags(0)
	log.SetOutput(os.Stderr)
	configureClientPayload()

	if len(os.Args) < 2 {
		fail("usage: cued-whatsapp-helper <version|status|pair|session>")
	}

	switch os.Args[1] {
	case "version":
		writeJSON(os.Stdout, map[string]string{"version": helperVersion})
	case "status":
		if err := runStatus(os.Args[2:]); err != nil {
			fail(err.Error())
		}
	case "pair":
		if err := runPair(os.Args[2:]); err != nil {
			fail(err.Error())
		}
	case "session":
		if err := runSession(os.Args[2:]); err != nil {
			fail(err.Error())
		}
	default:
		fail(fmt.Sprintf("unknown command: %s", os.Args[1]))
	}
}

func configureClientPayload() {
	store.SetOSInfo("macOS", [3]uint32{14, 4, 0})
	store.BaseClientPayload.UserAgent.Platform = waWa6.ClientPayload_UserAgent_MACOS.Enum()
	store.BaseClientPayload.UserAgent.Manufacturer = proto.String("Apple")
	store.BaseClientPayload.UserAgent.Device = proto.String("Desktop")
	store.BaseClientPayload.WebInfo.WebSubPlatform = waWa6.ClientPayload_WebInfo_DARWIN.Enum()
	store.DeviceProps.Os = proto.String("macOS")
	store.DeviceProps.PlatformType = waCompanionReg.DeviceProps_DESKTOP.Enum()
}

func runStatus(args []string) error {
	flags := flag.NewFlagSet("status", flag.ContinueOnError)
	storeDir := flags.String("store-dir", "", "store directory")
	flags.SetOutput(ioDiscard{})
	if err := flags.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*storeDir) == "" {
		return errors.New("--store-dir is required")
	}

	state, err := newHelperState(*storeDir)
	if err != nil {
		return err
	}

	deviceStore, _, err := openStore(*storeDir)
	if err != nil {
		return err
	}
	metadata := state.getMetadata()
	writeJSON(os.Stdout, map[string]interface{}{
		"authenticated": deviceStore.ID != nil,
		"accountJid":    firstNonEmpty(metadata.AccountJID, jidString(deviceStore.ID)),
		"pushName":      emptyToNil(metadata.PushName),
		"helperVersion": helperVersion,
	})
	return nil
}

func runPair(args []string) error {
	flags := flag.NewFlagSet("pair", flag.ContinueOnError)
	storeDir := flags.String("store-dir", "", "store directory")
	deviceName := flags.String("device-name", "Cued", "device name")
	flags.SetOutput(ioDiscard{})
	if err := flags.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*storeDir) == "" {
		return errors.New("--store-dir is required")
	}

	state, client, cleanup, err := initClient(*storeDir)
	if err != nil {
		return err
	}
	defer cleanup()
	defer disconnectQuietly(client)

	client.Store.PushName = *deviceName
	encoder := json.NewEncoder(os.Stdout)
	runtime := newHelperRuntime(client, state, encoder)
	done := make(chan struct{})

	client.AddEventHandler(func(evt interface{}) {
		switch evt.(type) {
		case *events.Connected:
			metadata := helperMetadata{
				AccountJID: jidString(client.Store.ID),
				PushName:   emptyString(client.Store.PushName),
			}
			state.setMetadata(metadata)
			runtime.emitEvent("connected", map[string]interface{}{
				"accountJid":    metadata.AccountJID,
				"pushName":      emptyToNil(metadata.PushName),
				"helperVersion": helperVersion,
			})
			select {
			case <-done:
			default:
				close(done)
			}
		case *events.Disconnected:
			runtime.emitEvent("disconnected", map[string]interface{}{
				"reason": "disconnected",
			})
		case *events.LoggedOut:
			runtime.emitEvent("error", map[string]string{
				"message": "logged out from WhatsApp",
			})
		}
	})

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	if client.Store.ID == nil {
		qrChan, err := client.GetQRChannel(ctx)
		if err != nil {
			return err
		}
		if err := client.Connect(); err != nil {
			return err
		}
		for {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case evt, ok := <-qrChan:
				if !ok {
					return nil
				}
				switch evt.Event {
				case "code":
					runtime.emitEvent("qr", map[string]string{
						"code": evt.Code,
					})
				case "error":
					return fmt.Errorf("qr pairing error: %v", evt.Error)
				case "timeout":
					return errors.New("pairing timed out")
				case "success":
				}
			case <-done:
				return nil
			}
		}
	}

	if err := client.Connect(); err != nil {
		return err
	}

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-done:
		return nil
	}
}

func runSession(args []string) error {
	flags := flag.NewFlagSet("session", flag.ContinueOnError)
	storeDir := flags.String("store-dir", "", "store directory")
	flags.SetOutput(ioDiscard{})
	if err := flags.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*storeDir) == "" {
		return errors.New("--store-dir is required")
	}

	state, client, cleanup, err := initClient(*storeDir)
	if err != nil {
		return err
	}
	defer cleanup()
	defer disconnectQuietly(client)

	runtime := newHelperRuntime(client, state, json.NewEncoder(os.Stdout))

	client.AddEventHandler(func(evt interface{}) {
		runtime.handleEvent(evt)
	})

	if err := client.Connect(); err != nil {
		return err
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	commandErr := make(chan error, 1)
	go runtime.readCommands(ctx, commandErr)

	select {
	case <-ctx.Done():
		return nil
	case err := <-commandErr:
		return err
	}
}

func (r *helperRuntime) readCommands(ctx context.Context, errs chan<- error) {
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		select {
		case <-ctx.Done():
			errs <- nil
			return
		default:
		}

		var command commandEnvelope
		if err := json.Unmarshal(scanner.Bytes(), &command); err != nil {
			r.writeResponse(0, false, nil, err)
			continue
		}

		switch command.Command {
		case "status":
			metadata := r.state.getMetadata()
			r.writeResponse(command.ID, true, map[string]interface{}{
				"accountJid":    firstNonEmpty(metadata.AccountJID, jidString(r.client.Store.ID)),
				"pushName":      emptyToNil(firstNonEmpty(metadata.PushName, r.client.Store.PushName)),
				"connected":     r.isConnected(),
				"helperVersion": helperVersion,
			}, nil)
		case "resync":
			r.writeResponse(command.ID, true, r.state.getSnapshot(), nil)
		case "downloadMedia":
			result, err := r.downloadMedia(ctx, command.ChatJID, command.MessageID, command.AttachmentIndex)
			r.writeResponse(command.ID, err == nil, result, err)
		case "sendText":
			result, err := r.sendText(ctx, command.Target, command.Text)
			r.writeResponse(command.ID, err == nil, result, err)
		default:
			r.writeResponse(command.ID, false, nil, fmt.Errorf("unsupported command: %s", command.Command))
		}
	}

	errs <- scanner.Err()
}

func (r *helperRuntime) sendText(ctx context.Context, target string, text string) (map[string]interface{}, error) {
	targetJID, err := types.ParseJID(target)
	if err != nil {
		return nil, err
	}

	message := &waProto.Message{
		Conversation: proto.String(text),
	}
	resp, err := r.client.SendMessage(ctx, targetJID, message)
	if err != nil {
		return nil, err
	}

	chatJID := normalizeJID(targetJID.String())
	messageID := resp.ID
	timestamp := time.Now().UnixMilli()
	snapshot := messageSnapshot{
		MessageID: messageID,
		ChatJID:   chatJID,
		SenderJID: stringPtr(jidString(r.client.Store.ID)),
		FromMe:    true,
		Timestamp: timestamp,
		Text:      text,
		Status:    stringPtr("sent"),
		Attachments: []attachmentSnapshot{},
	}
	r.state.setMessage(snapshot)

	return map[string]interface{}{
		"messageID": messageID,
		"chatJID":   chatJID,
		"timestamp": timestamp,
	}, nil
}

func (r *helperRuntime) downloadMedia(ctx context.Context, chatJID string, messageID string, attachmentIndex int) (map[string]interface{}, error) {
	if attachmentIndex != 0 {
		return nil, fmt.Errorf("unsupported attachment index: %d", attachmentIndex)
	}

	snapshot := r.state.findMessage(chatJID, messageID)
	if snapshot == nil {
		return nil, fmt.Errorf("message not found: %s/%s", chatJID, messageID)
	}
	if snapshot.MessageProto == nil || strings.TrimSpace(*snapshot.MessageProto) == "" {
		return nil, errors.New("message does not have downloadable media metadata")
	}

	protoBytes, err := base64.StdEncoding.DecodeString(*snapshot.MessageProto)
	if err != nil {
		return nil, fmt.Errorf("decode message proto: %w", err)
	}

	var message waProto.Message
	if err := proto.Unmarshal(protoBytes, &message); err != nil {
		return nil, fmt.Errorf("unmarshal message proto: %w", err)
	}

	data, err := r.client.DownloadAny(ctx, &message)
	if err != nil {
		return nil, err
	}

	var attachment *attachmentSnapshot
	if len(snapshot.Attachments) > 0 {
		attachment = &snapshot.Attachments[0]
	}

	return map[string]interface{}{
		"dataBase64": base64.StdEncoding.EncodeToString(data),
		"mimeType":   valueOrNil(attachment, func(value attachmentSnapshot) *string { return value.MimeType }),
		"filename":   valueOrNil(attachment, func(value attachmentSnapshot) *string { return value.Filename }),
		"sizeBytes":  len(data),
	}, nil
}

func (r *helperRuntime) handleEvent(evt interface{}) {
	switch event := evt.(type) {
	case *events.Connected:
		r.setConnected(true)
		metadata := helperMetadata{
			AccountJID: jidString(r.client.Store.ID),
			PushName:   emptyString(r.client.Store.PushName),
		}
		r.state.setMetadata(metadata)
		r.emitEvent("connected", map[string]interface{}{
			"accountJid":    metadata.AccountJID,
			"pushName":      emptyToNil(metadata.PushName),
			"helperVersion": helperVersion,
		})
	case *events.Disconnected:
		r.setConnected(false)
		r.emitEvent("disconnected", map[string]string{
			"reason": "disconnected",
		})
	case *events.LoggedOut:
		r.setConnected(false)
		r.emitEvent("error", map[string]string{
			"message": "logged out from WhatsApp",
		})
	case *events.PushNameSetting:
		metadata := r.state.getMetadata()
		if event.Action != nil {
			metadata.PushName = event.Action.GetName()
		}
		r.state.setMetadata(metadata)
	case *events.Message:
		r.handleMessageEvent(event)
	case *events.Receipt:
		r.handleReceiptEvent(event)
	case *events.HistorySync:
		r.handleHistorySyncEvent(event)
	}
}

func (r *helperRuntime) handleMessageEvent(event *events.Message) {
	snapshot := messageFromEvent(event)
	r.state.setMessage(snapshot)
	contact := contactFromMessage(snapshot)
	r.state.setContact(contact)
	r.state.setChat(chatFromMessage(snapshot))
	r.emitEvent("contact_upsert", contact)
	r.emitEvent("chat_upsert", chatFromMessage(snapshot))
	r.emitEvent("message_upsert", snapshot)
}

func (r *helperRuntime) handleReceiptEvent(event *events.Receipt) {
	if len(event.MessageIDs) == 0 {
		return
	}
	status := receiptStatus(event)
	receipt := receiptSnapshot{
		MessageID: event.MessageIDs[0],
		ChatJID:   normalizeJID(event.Chat.String()),
		FromMe:    true,
		Status:    emptyToNil(status),
	}
	nowMillis := time.Now().UnixMilli()
	if status == "delivered" || status == "read" {
		receipt.DeliveredAt = &nowMillis
	}
	if status == "read" {
		receipt.ReadAt = &nowMillis
	}
	r.state.applyReceipt(receipt)
	r.emitEvent("receipt_update", receipt)
}

func (r *helperRuntime) handleHistorySyncEvent(event *events.HistorySync) {
	snapshot := r.state.getSnapshot()
	completedAt := time.Now().UnixMilli()
	r.emitEvent("history_sync", map[string]interface{}{
		"contacts":    snapshot.Contacts,
		"chats":       snapshot.Chats,
		"messages":    snapshot.Messages,
		"completedAt": completedAt,
	})
}

func messageFromEvent(event *events.Message) messageSnapshot {
	chatJID := normalizeJID(event.Info.Chat.String())
	senderJID := normalizeJID(event.Info.Sender.String())
	var participantJID *string
	if event.Info.IsGroup {
		participantJID = stringPtr(senderJID)
	}
	pushName := emptyToNil(event.Info.PushName)
	status := "delivered"
	if event.Info.IsFromMe {
		status = "sent"
	}
	attachments, messageProto := attachmentsFromMessage(event.Info.ID, chatJID, event.Message)
	return messageSnapshot{
		MessageID:      event.Info.ID,
		ChatJID:        chatJID,
		SenderJID:      stringPtr(senderJID),
		ParticipantJID: participantJID,
		FromMe:         event.Info.IsFromMe,
		Timestamp:      event.Info.Timestamp.UnixMilli(),
		Text:           extractText(event.Message),
		PushName:       pushName,
		Status:         &status,
		MessageProto:   messageProto,
		Attachments:    attachments,
	}
}

func attachmentsFromMessage(messageID string, chatJID string, message *waProto.Message) ([]attachmentSnapshot, *string) {
	if message == nil {
		return nil, nil
	}

	encodedMessage := func() *string {
		data, err := proto.Marshal(message)
		if err != nil {
			return nil
		}
		return stringPtr(base64.StdEncoding.EncodeToString(data))
	}

	makeAttachment := func(kind string, filename *string, mimeType *string, sizeBytes *int64, text *string) attachmentSnapshot {
		return attachmentSnapshot{
			ID:         fmt.Sprintf("%s:0", kind),
			Kind:       kind,
			Filename:   filename,
			MimeType:   mimeType,
			SizeBytes:  sizeBytes,
			Text:       text,
			AccessKind: "provider_fetch",
			AccessRef: map[string]interface{}{
				"chatJID":         chatJID,
				"messageID":       messageID,
				"attachmentIndex": 0,
			},
			Availability: "available",
			ProviderMeta: map[string]interface{}{
				"kind": kind,
			},
		}
	}

	if image := message.GetImageMessage(); image != nil {
		return []attachmentSnapshot{
			makeAttachment(
				"image",
				nil,
				emptyToNil(image.GetMimetype()),
				int64PtrIfPositive(int64(image.GetFileLength())),
				emptyToNil(strings.TrimSpace(image.GetCaption())),
			),
		}, encodedMessage()
	}
	if video := message.GetVideoMessage(); video != nil {
		return []attachmentSnapshot{
			makeAttachment(
				"video",
				nil,
				emptyToNil(video.GetMimetype()),
				int64PtrIfPositive(int64(video.GetFileLength())),
				emptyToNil(strings.TrimSpace(video.GetCaption())),
			),
		}, encodedMessage()
	}
	if document := message.GetDocumentMessage(); document != nil {
		return []attachmentSnapshot{
			makeAttachment(
				"document",
				emptyToNil(document.GetFileName()),
				emptyToNil(document.GetMimetype()),
				int64PtrIfPositive(int64(document.GetFileLength())),
				emptyToNil(strings.TrimSpace(document.GetCaption())),
			),
		}, encodedMessage()
	}
	if audio := message.GetAudioMessage(); audio != nil {
		return []attachmentSnapshot{
			makeAttachment(
				"audio",
				nil,
				emptyToNil(audio.GetMimetype()),
				int64PtrIfPositive(int64(audio.GetFileLength())),
				nil,
			),
		}, encodedMessage()
	}
	if sticker := message.GetStickerMessage(); sticker != nil {
		return []attachmentSnapshot{
			makeAttachment(
				"sticker",
				nil,
				emptyToNil(sticker.GetMimetype()),
				int64PtrIfPositive(int64(sticker.GetFileLength())),
				nil,
			),
		}, encodedMessage()
	}

	return nil, nil
}

func contactFromMessage(message messageSnapshot) contactSnapshot {
	candidate := message.ChatJID
	if !message.FromMe {
		if message.ParticipantJID != nil && *message.ParticipantJID != "" {
			candidate = *message.ParticipantJID
		} else if message.SenderJID != nil && *message.SenderJID != "" {
			candidate = *message.SenderJID
		}
	}
	phone := phoneFromJID(candidate)
	return contactSnapshot{
		JID:      candidate,
		Phone:    phone,
		PushName: message.PushName,
	}
}

func chatFromMessage(message messageSnapshot) chatSnapshot {
	isGroup := strings.HasSuffix(normalizeJID(message.ChatJID), "@g.us")
	participants := []string{}
	if message.SenderJID != nil && *message.SenderJID != "" {
		participants = append(participants, *message.SenderJID)
	}
	if message.ParticipantJID != nil && *message.ParticipantJID != "" {
		participants = append(participants, *message.ParticipantJID)
	}
	return chatSnapshot{
		JID:          message.ChatJID,
		Name:         message.PushName,
		IsGroup:      isGroup,
		Participants: participants,
	}
}

func receiptStatus(event *events.Receipt) string {
	switch event.Type {
	case types.ReceiptTypeRead, types.ReceiptTypeReadSelf:
		return "read"
	default:
		return "delivered"
	}
}

func extractText(message *waProto.Message) string {
	if message == nil {
		return ""
	}
	if value := strings.TrimSpace(message.GetConversation()); value != "" {
		return value
	}
	if extended := message.GetExtendedTextMessage(); extended != nil {
		return strings.TrimSpace(extended.GetText())
	}
	if image := message.GetImageMessage(); image != nil {
		return strings.TrimSpace(image.GetCaption())
	}
	if video := message.GetVideoMessage(); video != nil {
		return strings.TrimSpace(video.GetCaption())
	}
	if document := message.GetDocumentMessage(); document != nil {
		return strings.TrimSpace(document.GetCaption())
	}
	return ""
}

func initClient(storeDir string) (*helperState, *whatsmeow.Client, func(), error) {
	state, err := newHelperState(storeDir)
	if err != nil {
		return nil, nil, nil, err
	}
	deviceStore, container, err := openStore(storeDir)
	if err != nil {
		return nil, nil, nil, err
	}
	client := whatsmeow.NewClient(deviceStore, nil)
	cleanup := func() {
		if container != nil {
			_ = container.Close()
		}
	}
	return state, client, cleanup, nil
}

func openStore(storeDir string) (*store.Device, *sqlstore.Container, error) {
	dbPath := filepath.Join(storeDir, "whatsmeow.db")
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s", dbPath))
	if err != nil {
		return nil, nil, err
	}
	if _, err := db.Exec("PRAGMA foreign_keys = ON"); err != nil {
		_ = db.Close()
		return nil, nil, err
	}

	container := sqlstore.NewWithDB(db, "sqlite3", nil)
	if err := container.Upgrade(context.Background()); err != nil {
		_ = db.Close()
		return nil, nil, err
	}
	deviceStore, err := container.GetFirstDevice(context.Background())
	if err != nil {
		_ = db.Close()
		return nil, nil, err
	}
	return deviceStore, container, nil
}

func writeJSON(writer *os.File, value interface{}) {
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
}

func writeJSONFileAtomic(path string, value interface{}) error {
	tempPath := path + ".tmp"
	file, err := os.Create(tempPath)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(file)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(tempPath, path)
}

func readJSONFile(path string, target interface{}) {
	file, err := os.Open(path)
	if err != nil {
		return
	}
	defer file.Close()
	_ = json.NewDecoder(file).Decode(target)
}

func disconnectQuietly(client *whatsmeow.Client) {
	if client != nil {
		client.Disconnect()
	}
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}

func normalizeJID(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func phoneFromJID(value string) *string {
	normalized := normalizeJID(value)
	parts := strings.Split(normalized, "@")
	if len(parts) != 2 {
		return nil
	}
	if parts[1] != "s.whatsapp.net" {
		return nil
	}
	if parts[0] == "" {
		return nil
	}
	result := "+" + parts[0]
	return &result
}

func jidString(jid *types.JID) string {
	if jid == nil {
		return ""
	}
	return normalizeJID(jid.String())
}

func stringPtr(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	copy := value
	return &copy
}

func emptyToNil(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return &value
}

func emptyString(value string) string {
	return strings.TrimSpace(value)
}

func int64PtrIfPositive(value int64) *int64 {
	if value <= 0 {
		return nil
	}
	copy := value
	return &copy
}

func valueOrNil[T any](value *T, getter func(T) *string) *string {
	if value == nil {
		return nil
	}
	return getter(*value)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

type ioDiscard struct{}

func (ioDiscard) Write(p []byte) (int, error) {
	return len(p), nil
}
