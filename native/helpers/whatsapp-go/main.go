package main

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "modernc.org/sqlite"

	"go.mau.fi/whatsmeow"
	waProto "go.mau.fi/whatsmeow/binary/proto"
	"go.mau.fi/whatsmeow/proto/waCompanionReg"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waWa6"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

const helperVersion = "0.1.0"
const pairConnectGracePeriod = 20 * time.Second
const defaultResyncLimit = 1000

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
	ID      int    `json:"id"`
	Command string `json:"command"`
	Target  string `json:"target,omitempty"`
	Text    string `json:"text,omitempty"`
	Cursor  string `json:"cursor,omitempty"`
	SinceMS *int64 `json:"sinceMs,omitempty"`
	Limit   int    `json:"limit,omitempty"`
}

type helperState struct {
	storeDir     string
	metadataPath string

	mu       sync.Mutex
	metadata helperMetadata
	cache    *syncCache
}

type resyncPage struct {
	Contacts    []contactSnapshot `json:"contacts,omitempty"`
	Chats       []chatSnapshot    `json:"chats,omitempty"`
	Messages    []messageSnapshot `json:"messages,omitempty"`
	NextCursor  *string           `json:"nextCursor,omitempty"`
	HasMore     bool              `json:"hasMore"`
	CompletedAt int64             `json:"completedAt"`
}

type syncCache struct {
	db *sql.DB
}

func newHelperState(storeDir string) (*helperState, error) {
	if err := os.MkdirAll(storeDir, 0o700); err != nil {
		return nil, err
	}
	cache, err := openSyncCache(storeDir)
	if err != nil {
		return nil, err
	}
	state := &helperState{
		storeDir:     storeDir,
		metadataPath: filepath.Join(storeDir, "metadata.json"),
		cache:        cache,
	}
	state.load()
	return state, nil
}

func (s *helperState) load() {
	s.mu.Lock()
	defer s.mu.Unlock()
	readJSONFile(s.metadataPath, &s.metadata)
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
	_ = s.cache.upsertContact(contact)
}

func (s *helperState) setChat(chat chatSnapshot) {
	_ = s.cache.upsertChat(chat)
}

func (s *helperState) setMessage(message messageSnapshot) {
	_ = s.cache.upsertMessage(message)
}

func (s *helperState) applyReceipt(receipt receiptSnapshot) {
	_ = s.cache.applyReceipt(receipt)
}

func (s *helperState) getSnapshot() stateSnapshot {
	snapshot, err := s.cache.getSnapshot()
	if err != nil {
		return stateSnapshot{}
	}
	return snapshot
}

func (s *helperState) getResyncPage(sinceMS *int64, cursor string, limit int) (resyncPage, error) {
	return s.cache.getResyncPage(sinceMS, cursor, limit)
}

func (s *helperState) applySnapshot(snapshot stateSnapshot) error {
	return s.cache.applySnapshot(snapshot)
}

func (s *helperState) close() error {
	if s.cache == nil {
		return nil
	}
	return s.cache.close()
}

func openSyncCache(storeDir string) (*syncCache, error) {
	dbPath := filepath.Join(storeDir, "history.db")
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s", dbPath))
	if err != nil {
		return nil, err
	}
	schema := []string{
		`CREATE TABLE IF NOT EXISTS contacts (
			jid TEXT PRIMARY KEY,
			phone TEXT,
			name TEXT,
			push_name TEXT,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS chats (
			jid TEXT PRIMARY KEY,
			name TEXT,
			is_group INTEGER NOT NULL,
			participants_json TEXT,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS messages (
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
		)`,
		`CREATE INDEX IF NOT EXISTS idx_messages_timestamp
			ON messages(timestamp, chat_jid, message_id)`,
		`CREATE INDEX IF NOT EXISTS idx_messages_updated_at
			ON messages(updated_at, timestamp, chat_jid, message_id)`,
		`CREATE INDEX IF NOT EXISTS idx_contacts_updated_at
			ON contacts(updated_at, jid)`,
		`CREATE INDEX IF NOT EXISTS idx_chats_updated_at
			ON chats(updated_at, jid)`,
	}
	for _, statement := range schema {
		if _, err := db.Exec(statement); err != nil {
			_ = db.Close()
			return nil, err
		}
	}
	return &syncCache{db: db}, nil
}

func (c *syncCache) close() error {
	if c == nil || c.db == nil {
		return nil
	}
	return c.db.Close()
}

func (c *syncCache) applySnapshot(snapshot stateSnapshot) error {
	tx, err := c.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, contact := range snapshot.Contacts {
		if err := upsertContactTx(tx, contact, nowMillis()); err != nil {
			return err
		}
	}
	for _, chat := range snapshot.Chats {
		if err := upsertChatTx(tx, chat, nowMillis()); err != nil {
			return err
		}
	}
	for _, message := range snapshot.Messages {
		if err := upsertMessageTx(tx, message, nowMillis()); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (c *syncCache) upsertContact(contact contactSnapshot) error {
	tx, err := c.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := upsertContactTx(tx, contact, nowMillis()); err != nil {
		return err
	}
	return tx.Commit()
}

func (c *syncCache) upsertChat(chat chatSnapshot) error {
	tx, err := c.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := upsertChatTx(tx, chat, nowMillis()); err != nil {
		return err
	}
	return tx.Commit()
}

func (c *syncCache) upsertMessage(message messageSnapshot) error {
	tx, err := c.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := upsertMessageTx(tx, message, nowMillis()); err != nil {
		return err
	}
	return tx.Commit()
}

func (c *syncCache) applyReceipt(receipt receiptSnapshot) error {
	_, err := c.db.Exec(
		`UPDATE messages
		 SET status = COALESCE(?, status),
		     delivered_at = COALESCE(?, delivered_at),
		     read_at = COALESCE(?, read_at),
		     updated_at = ?
		 WHERE chat_jid = ? AND message_id = ?`,
		nullableString(receipt.Status),
		nullableInt64(receipt.DeliveredAt),
		nullableInt64(receipt.ReadAt),
		nowMillis(),
		normalizeJID(receipt.ChatJID),
		receipt.MessageID,
	)
	return err
}

func (c *syncCache) getSnapshot() (stateSnapshot, error) {
	contacts, err := c.queryContacts(nil)
	if err != nil {
		return stateSnapshot{}, err
	}
	chats, err := c.queryChats(nil)
	if err != nil {
		return stateSnapshot{}, err
	}
	messages, _, _, err := c.queryMessages(nil, 0, -1)
	if err != nil {
		return stateSnapshot{}, err
	}
	return stateSnapshot{
		Contacts: contacts,
		Chats:    chats,
		Messages: messages,
	}, nil
}

func (c *syncCache) getResyncPage(sinceMS *int64, cursor string, limit int) (resyncPage, error) {
	offset, err := parseResyncCursor(cursor)
	if err != nil {
		return resyncPage{}, err
	}
	if limit <= 0 {
		limit = defaultResyncLimit
	}

	page := resyncPage{
		HasMore:     false,
		CompletedAt: nowMillis(),
	}
	if offset == 0 {
		page.Contacts, err = c.queryContacts(sinceMS)
		if err != nil {
			return resyncPage{}, err
		}
		page.Chats, err = c.queryChats(sinceMS)
		if err != nil {
			return resyncPage{}, err
		}
	}

	messages, total, returned, err := c.queryMessages(sinceMS, offset, limit)
	if err != nil {
		return resyncPage{}, err
	}
	page.Messages = messages
	if offset+returned < total {
		nextCursor := strconv.Itoa(offset + returned)
		page.NextCursor = &nextCursor
		page.HasMore = true
	}
	return page, nil
}

func (c *syncCache) queryContacts(sinceMS *int64) ([]contactSnapshot, error) {
	query := `SELECT jid, phone, name, push_name FROM contacts`
	args := []any{}
	if sinceMS != nil {
		query += ` WHERE updated_at > ?`
		args = append(args, *sinceMS)
	}
	query += ` ORDER BY jid`
	rows, err := c.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var contacts []contactSnapshot
	for rows.Next() {
		var jid string
		var phone, name, pushName sql.NullString
		if err := rows.Scan(&jid, &phone, &name, &pushName); err != nil {
			return nil, err
		}
		contact := contactSnapshot{JID: jid}
		if phone.Valid {
			contact.Phone = stringPtr(phone.String)
		}
		if name.Valid {
			contact.Name = stringPtr(name.String)
		}
		if pushName.Valid {
			contact.PushName = stringPtr(pushName.String)
		}
		contacts = append(contacts, contact)
	}
	return contacts, rows.Err()
}

func (c *syncCache) queryChats(sinceMS *int64) ([]chatSnapshot, error) {
	query := `SELECT jid, name, is_group, participants_json FROM chats`
	args := []any{}
	if sinceMS != nil {
		query += ` WHERE updated_at > ?`
		args = append(args, *sinceMS)
	}
	query += ` ORDER BY jid`
	rows, err := c.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var chats []chatSnapshot
	for rows.Next() {
		var jid string
		var name, participantsJSON sql.NullString
		var isGroup int64
		if err := rows.Scan(&jid, &name, &isGroup, &participantsJSON); err != nil {
			return nil, err
		}
		chat := chatSnapshot{
			JID:     jid,
			IsGroup: isGroup == 1,
		}
		if name.Valid {
			chat.Name = stringPtr(name.String)
		}
		if participantsJSON.Valid && participantsJSON.String != "" {
			_ = json.Unmarshal([]byte(participantsJSON.String), &chat.Participants)
		}
		chats = append(chats, chat)
	}
	return chats, rows.Err()
}

func (c *syncCache) queryMessages(
	sinceMS *int64,
	offset int,
	limit int,
) ([]messageSnapshot, int, int, error) {
	countQuery := `SELECT COUNT(*) FROM messages`
	selectQuery := `SELECT chat_jid, message_id, sender_jid, participant_jid, from_me, timestamp, text, push_name, status, delivered_at, read_at FROM messages`
	args := []any{}
	if sinceMS != nil {
		countQuery += ` WHERE updated_at > ?`
		selectQuery += ` WHERE updated_at > ?`
		args = append(args, *sinceMS)
	}
	var total int
	if err := c.db.QueryRow(countQuery, args...).Scan(&total); err != nil {
		return nil, 0, 0, err
	}
	if limit < 0 {
		limit = total
		offset = 0
	}
	selectQuery += ` ORDER BY timestamp, chat_jid, message_id LIMIT ? OFFSET ?`
	selectArgs := append(append([]any{}, args...), limit, offset)
	rows, err := c.db.Query(selectQuery, selectArgs...)
	if err != nil {
		return nil, 0, 0, err
	}
	defer rows.Close()

	var messages []messageSnapshot
	for rows.Next() {
		var chatJID string
		var messageID string
		var senderJID, participantJID, pushName, status sql.NullString
		var fromMe int64
		var timestamp int64
		var text string
		var deliveredAt, readAt sql.NullInt64
		if err := rows.Scan(
			&chatJID,
			&messageID,
			&senderJID,
			&participantJID,
			&fromMe,
			&timestamp,
			&text,
			&pushName,
			&status,
			&deliveredAt,
			&readAt,
		); err != nil {
			return nil, 0, 0, err
		}
		message := messageSnapshot{
			MessageID: messageID,
			ChatJID:   chatJID,
			FromMe:    fromMe == 1,
			Timestamp: timestamp,
			Text:      text,
		}
		if senderJID.Valid {
			message.SenderJID = stringPtr(senderJID.String)
		}
		if participantJID.Valid {
			message.ParticipantJID = stringPtr(participantJID.String)
		}
		if pushName.Valid {
			message.PushName = stringPtr(pushName.String)
		}
		if status.Valid {
			message.Status = stringPtr(status.String)
		}
		if deliveredAt.Valid {
			message.DeliveredAt = int64Ptr(deliveredAt.Int64)
		}
		if readAt.Valid {
			message.ReadAt = int64Ptr(readAt.Int64)
		}
		messages = append(messages, message)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, 0, err
	}
	return messages, total, len(messages), nil
}

func upsertContactTx(tx *sql.Tx, contact contactSnapshot, updatedAt int64) error {
	_, err := tx.Exec(
		`INSERT INTO contacts (jid, phone, name, push_name, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(jid) DO UPDATE SET
		   phone = excluded.phone,
		   name = excluded.name,
		   push_name = excluded.push_name,
		   updated_at = excluded.updated_at`,
		normalizeJID(contact.JID),
		nullableString(contact.Phone),
		nullableString(contact.Name),
		nullableString(contact.PushName),
		updatedAt,
	)
	return err
}

func upsertChatTx(tx *sql.Tx, chat chatSnapshot, updatedAt int64) error {
	participantsJSON, err := json.Marshal(chat.Participants)
	if err != nil {
		return err
	}
	_, err = tx.Exec(
		`INSERT INTO chats (jid, name, is_group, participants_json, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(jid) DO UPDATE SET
		   name = excluded.name,
		   is_group = excluded.is_group,
		   participants_json = excluded.participants_json,
		   updated_at = excluded.updated_at`,
		normalizeJID(chat.JID),
		nullableString(chat.Name),
		boolToInt(chat.IsGroup),
		string(participantsJSON),
		updatedAt,
	)
	return err
}

func upsertMessageTx(tx *sql.Tx, message messageSnapshot, updatedAt int64) error {
	_, err := tx.Exec(
		`INSERT INTO messages (
		   chat_jid, message_id, sender_jid, participant_jid, from_me, timestamp, text, push_name,
		   status, delivered_at, read_at, updated_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(chat_jid, message_id) DO UPDATE SET
		   sender_jid = excluded.sender_jid,
		   participant_jid = excluded.participant_jid,
		   from_me = excluded.from_me,
		   timestamp = excluded.timestamp,
		   text = excluded.text,
		   push_name = excluded.push_name,
		   status = excluded.status,
		   delivered_at = COALESCE(excluded.delivered_at, messages.delivered_at),
		   read_at = COALESCE(excluded.read_at, messages.read_at),
		   updated_at = excluded.updated_at`,
		normalizeJID(message.ChatJID),
		message.MessageID,
		nullableString(message.SenderJID),
		nullableString(message.ParticipantJID),
		boolToInt(message.FromMe),
		message.Timestamp,
		message.Text,
		nullableString(message.PushName),
		nullableString(message.Status),
		nullableInt64(message.DeliveredAt),
		nullableInt64(message.ReadAt),
		updatedAt,
	)
	return err
}

func parseResyncCursor(cursor string) (int, error) {
	trimmed := strings.TrimSpace(cursor)
	if trimmed == "" {
		return 0, nil
	}
	offset, err := strconv.Atoi(trimmed)
	if err != nil || offset < 0 {
		return 0, fmt.Errorf("invalid resync cursor: %q", cursor)
	}
	return offset, nil
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
	defer state.close()

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
		return waitForPairingCompletion(ctx, qrChan, done, runtime)
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

func waitForPairingCompletion(
	ctx context.Context,
	qrChan <-chan whatsmeow.QRChannelItem,
	done <-chan struct{},
	runtime *helperRuntime,
) error {
	pairingSucceeded := false
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case evt, ok := <-qrChan:
			if !ok {
				if pairingSucceeded {
					return waitForConnectedAfterPair(ctx, done)
				}
				return errors.New("QR channel closed before pairing completed")
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
				pairingSucceeded = true
				return waitForConnectedAfterPair(ctx, done)
			default:
				return fmt.Errorf("qr pairing ended with event %q", evt.Event)
			}
		case <-done:
			return nil
		}
	}
}

func waitForConnectedAfterPair(ctx context.Context, done <-chan struct{}) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-done:
		return nil
	case <-time.After(pairConnectGracePeriod):
		return errors.New("pairing succeeded but WhatsApp never established a connected session")
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
			page, err := r.state.getResyncPage(command.SinceMS, command.Cursor, command.Limit)
			r.writeResponse(command.ID, err == nil, page, err)
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
	}
	r.state.setMessage(snapshot)

	return map[string]interface{}{
		"messageID": messageID,
		"chatJID":   chatJID,
		"timestamp": timestamp,
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
	snapshot := historySyncBatchFromEvent(r.client, event)
	if err := r.state.applySnapshot(snapshot); err != nil {
		r.emitEvent("error", map[string]string{
			"message": fmt.Sprintf("failed to persist history sync: %v", err),
		})
		return
	}
	completedAt := time.Now().UnixMilli()
	r.emitEvent("history_sync", map[string]interface{}{
		"contacts":    snapshot.Contacts,
		"chats":       snapshot.Chats,
		"messages":    snapshot.Messages,
		"completedAt": completedAt,
	})
}

func historySyncBatchFromEvent(client *whatsmeow.Client, event *events.HistorySync) stateSnapshot {
	if event == nil || event.Data == nil {
		return stateSnapshot{}
	}

	contactsByJID := make(map[string]contactSnapshot)
	chatsByJID := make(map[string]chatSnapshot)
	messagesByKey := make(map[string]messageSnapshot)

	for _, pushname := range event.Data.GetPushnames() {
		contact := contactSnapshot{
			JID:      normalizeJID(pushname.GetID()),
			Phone:    phoneFromJID(pushname.GetID()),
			PushName: emptyToNil(pushname.GetPushname()),
		}
		mergeContactSnapshot(contactsByJID, contact)
	}

	for _, conversation := range event.Data.GetConversations() {
		chat := chatFromHistoryConversation(conversation)
		if chat.JID != "" {
			mergeChatSnapshot(chatsByJID, chat)
		}

		if !chat.IsGroup && chat.JID != "" {
			mergeContactSnapshot(contactsByJID, contactSnapshot{
				JID:   chat.JID,
				Phone: phoneFromJID(chat.JID),
				Name:  chat.Name,
			})
		}

		for _, participant := range conversation.GetParticipant() {
			jid := normalizeJID(participant.GetUserJID())
			if jid == "" {
				continue
			}
			mergeContactSnapshot(contactsByJID, contactSnapshot{
				JID:   jid,
				Phone: phoneFromJID(jid),
			})
		}

		chatJID, err := types.ParseJID(conversation.GetID())
		if err != nil {
			continue
		}
		for _, historyMsg := range conversation.GetMessages() {
			snapshot, ok := historyMessageSnapshot(client, chatJID, historyMsg)
			if !ok {
				continue
			}
			messagesByKey[snapshot.ChatJID+"::"+snapshot.MessageID] = snapshot
			mergeContactSnapshot(contactsByJID, contactFromMessage(snapshot))
			mergeChatSnapshot(chatsByJID, chatFromMessage(snapshot))
		}
	}

	contacts := make([]contactSnapshot, 0, len(contactsByJID))
	for _, contact := range contactsByJID {
		contacts = append(contacts, contact)
	}
	chats := make([]chatSnapshot, 0, len(chatsByJID))
	for _, chat := range chatsByJID {
		chats = append(chats, chat)
	}
	messages := make([]messageSnapshot, 0, len(messagesByKey))
	for _, message := range messagesByKey {
		messages = append(messages, message)
	}

	sort.Slice(contacts, func(i, j int) bool {
		return contacts[i].JID < contacts[j].JID
	})
	sort.Slice(chats, func(i, j int) bool {
		return chats[i].JID < chats[j].JID
	})
	sort.Slice(messages, func(i, j int) bool {
		if messages[i].Timestamp != messages[j].Timestamp {
			return messages[i].Timestamp < messages[j].Timestamp
		}
		if messages[i].ChatJID != messages[j].ChatJID {
			return messages[i].ChatJID < messages[j].ChatJID
		}
		return messages[i].MessageID < messages[j].MessageID
	})

	return stateSnapshot{
		Contacts: contacts,
		Chats:    chats,
		Messages: messages,
	}
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
	}
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

func historyMessageSnapshot(
	client *whatsmeow.Client,
	chatJID types.JID,
	historyMsg *waHistorySync.HistorySyncMsg,
) (messageSnapshot, bool) {
	if historyMsg == nil || historyMsg.GetMessage() == nil {
		return messageSnapshot{}, false
	}
	if client != nil {
		event, err := client.ParseWebMessage(chatJID, historyMsg.GetMessage())
		if err == nil {
			return messageFromEvent(event), true
		}
	}

	webMsg := historyMsg.GetMessage()
	normalizedChatJID := normalizeJID(chatJID.String())
	fromMe := webMsg.GetKey().GetFromMe()
	sender := normalizeJID(webMsg.GetParticipant())
	if sender == "" {
		sender = normalizeJID(webMsg.GetKey().GetParticipant())
	}
	if sender == "" {
		sender = normalizedChatJID
	}

	var participantJID *string
	if strings.HasSuffix(normalizedChatJID, "@g.us") && sender != "" {
		participantJID = stringPtr(sender)
	}
	status := "delivered"
	if fromMe {
		status = "sent"
	}

	return messageSnapshot{
		MessageID:      webMsg.GetKey().GetID(),
		ChatJID:        normalizedChatJID,
		SenderJID:      stringPtr(sender),
		ParticipantJID: participantJID,
		FromMe:         fromMe,
		Timestamp:      int64(webMsg.GetMessageTimestamp()) * 1000,
		Text:           extractText(webMsg.GetMessage()),
		PushName:       emptyToNil(webMsg.GetPushName()),
		Status:         stringPtr(status),
	}, true
}

func chatFromHistoryConversation(conversation *waHistorySync.Conversation) chatSnapshot {
	if conversation == nil {
		return chatSnapshot{}
	}
	participants := make([]string, 0, len(conversation.GetParticipant()))
	seen := make(map[string]struct{})
	for _, participant := range conversation.GetParticipant() {
		jid := normalizeJID(participant.GetUserJID())
		if jid == "" {
			continue
		}
		if _, ok := seen[jid]; ok {
			continue
		}
		seen[jid] = struct{}{}
		participants = append(participants, jid)
	}

	name := firstNonEmpty(
		conversation.GetName(),
		conversation.GetDisplayName(),
		conversation.GetUsername(),
	)

	return chatSnapshot{
		JID:          normalizeJID(conversation.GetID()),
		Name:         emptyToNil(name),
		IsGroup:      strings.HasSuffix(normalizeJID(conversation.GetID()), "@g.us"),
		Participants: participants,
	}
}

func mergeContactSnapshot(target map[string]contactSnapshot, contact contactSnapshot) {
	contact.JID = normalizeJID(contact.JID)
	if contact.JID == "" {
		return
	}
	current, ok := target[contact.JID]
	if !ok {
		target[contact.JID] = contact
		return
	}
	if current.Phone == nil {
		current.Phone = contact.Phone
	}
	if current.Name == nil {
		current.Name = contact.Name
	}
	if current.PushName == nil {
		current.PushName = contact.PushName
	}
	target[contact.JID] = current
}

func mergeChatSnapshot(target map[string]chatSnapshot, chat chatSnapshot) {
	chat.JID = normalizeJID(chat.JID)
	if chat.JID == "" {
		return
	}
	current, ok := target[chat.JID]
	if !ok {
		chat.Participants = uniqueStrings(chat.Participants)
		target[chat.JID] = chat
		return
	}
	if current.Name == nil {
		current.Name = chat.Name
	}
	current.IsGroup = current.IsGroup || chat.IsGroup
	current.Participants = uniqueStrings(append(current.Participants, chat.Participants...))
	target[chat.JID] = current
}

func uniqueStrings(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		normalized := normalizeJID(value)
		if normalized == "" {
			continue
		}
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		result = append(result, normalized)
	}
	return result
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
		_ = state.close()
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

func nowMillis() int64 {
	return time.Now().UnixMilli()
}

func nullableString(value *string) interface{} {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil
	}
	return *value
}

func nullableInt64(value *int64) interface{} {
	if value == nil {
		return nil
	}
	return *value
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
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

func int64Ptr(value int64) *int64 {
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
