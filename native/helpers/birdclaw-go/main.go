package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	helperVersion   = "0.1.0"
	protocolVersion = 1
	defaultLimit    = 5000
)

type accountRow struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Handle         string `json:"handle"`
	ExternalUserID string `json:"external_user_id"`
}

type profileRow struct {
	ID             string `json:"id"`
	Handle         string `json:"handle"`
	DisplayName    string `json:"display_name"`
	Bio            string `json:"bio"`
	FollowersCount int    `json:"followers_count"`
	FollowingCount int    `json:"following_count"`
	AvatarURL      string `json:"avatar_url"`
	Location       string `json:"location"`
	URL            string `json:"url"`
	VerifiedType   string `json:"verified_type"`
}

type conversationRow struct {
	ID                   string `json:"id"`
	ParticipantProfileID string `json:"participant_profile_id"`
	Title                string `json:"title"`
	LastMessageAt        string `json:"last_message_at"`
}

type messageRow struct {
	ID              string `json:"id"`
	ConversationID  string `json:"conversation_id"`
	SenderProfileID string `json:"sender_profile_id"`
	Text            string `json:"text"`
	CreatedAt       string `json:"created_at"`
	Direction       string `json:"direction"`
}

type followEdgeRow struct {
	Direction      string `json:"direction"`
	ProfileID      string `json:"profile_id"`
	ExternalUserID string `json:"external_user_id"`
	Source         string `json:"source"`
	FirstSeenAt    string `json:"first_seen_at"`
	LastSeenAt     string `json:"last_seen_at"`
}

type syncResult struct {
	HelperVersion   string            `json:"helperVersion"`
	ProtocolVersion int               `json:"protocolVersion"`
	DatabasePath    string            `json:"databasePath"`
	Account         accountRow        `json:"account"`
	Profiles        []profileRow      `json:"profiles"`
	Conversations   []conversationRow `json:"conversations"`
	Messages        []messageRow      `json:"messages"`
	FollowEdges     []followEdgeRow   `json:"followEdges"`
	HasMore         bool              `json:"hasMore"`
	NextCreatedAt   string            `json:"nextCreatedAt,omitempty"`
	NextMessageID   string            `json:"nextMessageId,omitempty"`
}

func main() {
	if len(os.Args) < 2 {
		fail(errors.New("usage: cued-birdclaw-helper <version|status|sync>"))
	}
	switch os.Args[1] {
	case "version":
		writeJSON(map[string]any{"version": helperVersion, "protocolVersion": protocolVersion})
	case "status":
		runStatus(os.Args[2:])
	case "sync":
		runSync(os.Args[2:])
	default:
		fail(fmt.Errorf("unknown command %q", os.Args[1]))
	}
}

func runStatus(args []string) {
	flags := flag.NewFlagSet("status", flag.ContinueOnError)
	dbPath := flags.String("db", "", "Birdclaw SQLite database path")
	if err := flags.Parse(args); err != nil {
		fail(err)
	}
	resolved, err := resolveDBPath(*dbPath)
	if err != nil {
		fail(err)
	}
	if _, err := os.Stat(resolved); err != nil {
		fail(fmt.Errorf("birdclaw database: %w", err))
	}
	var rows []map[string]any
	if err := sqliteJSON(context.Background(), resolved, "SELECT COUNT(*) AS accounts FROM accounts", &rows); err != nil {
		fail(err)
	}
	writeJSON(map[string]any{
		"helperVersion": helperVersion, "protocolVersion": protocolVersion,
		"databasePath": resolved, "available": true,
	})
}

func runSync(args []string) {
	flags := flag.NewFlagSet("sync", flag.ContinueOnError)
	dbPath := flags.String("db", "", "Birdclaw SQLite database path")
	account := flags.String("account", "default", "Birdclaw account id or handle")
	afterCreatedAt := flags.String("after-created-at", "", "exclusive message timestamp cursor")
	afterMessageID := flags.String("after-message-id", "", "exclusive message id cursor")
	limit := flags.Int("limit", defaultLimit, "maximum messages per page")
	if err := flags.Parse(args); err != nil {
		fail(err)
	}
	if *limit < 1 || *limit > 25000 {
		fail(errors.New("limit must be between 1 and 25000"))
	}
	resolved, err := resolveDBPath(*dbPath)
	if err != nil {
		fail(err)
	}
	ctx := context.Background()
	selected, err := selectAccount(ctx, resolved, *account)
	if err != nil {
		fail(err)
	}
	accountID := quoteSQL(selected.ID)
	var result syncResult
	result.HelperVersion = helperVersion
	result.ProtocolVersion = protocolVersion
	result.DatabasePath = resolved
	result.Account = selected

	conversationFilter := "SELECT id FROM dm_conversations WHERE account_id = " + accountID
	profileQuery := `SELECT p.id, COALESCE(p.handle, '') AS handle, COALESCE(p.display_name, '') AS display_name,
		COALESCE(p.bio, '') AS bio, COALESCE(p.followers_count, 0) AS followers_count,
		COALESCE(p.following_count, 0) AS following_count, COALESCE(p.avatar_url, '') AS avatar_url,
		COALESCE(p.location, '') AS location, COALESCE(p.url, '') AS url,
		COALESCE(p.verified_type, '') AS verified_type
		FROM profiles p WHERE p.id IN (
			SELECT participant_profile_id FROM dm_conversations WHERE account_id = ` + accountID + `
			UNION SELECT sender_profile_id FROM dm_messages WHERE conversation_id IN (` + conversationFilter + `)
			UNION SELECT profile_id FROM follow_edges WHERE account_id = ` + accountID + ` AND current = 1
		) ORDER BY lower(p.handle), p.id`
	if err := sqliteJSON(ctx, resolved, profileQuery, &result.Profiles); err != nil {
		fail(err)
	}
	if err := sqliteJSON(ctx, resolved, `SELECT id, participant_profile_id, COALESCE(title, '') AS title,
		COALESCE(last_message_at, '') AS last_message_at FROM dm_conversations
		WHERE account_id = `+accountID+` ORDER BY last_message_at, id`, &result.Conversations); err != nil {
		fail(err)
	}
	cursorFilter := ""
	if *afterCreatedAt != "" {
		cursorFilter = " AND (m.created_at > " + quoteSQL(*afterCreatedAt) +
			" OR (m.created_at = " + quoteSQL(*afterCreatedAt) + " AND m.id > " + quoteSQL(*afterMessageID) + "))"
	}
	messageQuery := `SELECT m.id, m.conversation_id, COALESCE(m.sender_profile_id, '') AS sender_profile_id,
		COALESCE(m.text, '') AS text, m.created_at, COALESCE(m.direction, '') AS direction
		FROM dm_messages m WHERE m.conversation_id IN (` + conversationFilter + `)` + cursorFilter +
		" ORDER BY m.created_at, m.id LIMIT " + strconv.Itoa(*limit+1)
	if err := sqliteJSON(ctx, resolved, messageQuery, &result.Messages); err != nil {
		fail(err)
	}
	if len(result.Messages) > *limit {
		result.Messages = result.Messages[:*limit]
		result.HasMore = true
	}
	if len(result.Messages) > 0 {
		last := result.Messages[len(result.Messages)-1]
		result.NextCreatedAt = last.CreatedAt
		result.NextMessageID = last.ID
	}
	if err := sqliteJSON(ctx, resolved, `SELECT direction, profile_id,
		COALESCE(external_user_id, '') AS external_user_id, COALESCE(source, '') AS source,
		COALESCE(first_seen_at, '') AS first_seen_at, COALESCE(last_seen_at, '') AS last_seen_at
		FROM follow_edges WHERE account_id = `+accountID+` AND current = 1 ORDER BY profile_id, direction`, &result.FollowEdges); err != nil {
		fail(err)
	}
	writeJSON(result)
}

func selectAccount(ctx context.Context, dbPath, requested string) (accountRow, error) {
	where := ""
	if strings.TrimSpace(requested) != "" && requested != "default" {
		value := strings.TrimPrefix(strings.TrimSpace(requested), "@")
		where = " WHERE id = " + quoteSQL(value) + " OR handle = " + quoteSQL(value)
	}
	var rows []accountRow
	err := sqliteJSON(ctx, dbPath, `SELECT id, COALESCE(name, '') AS name, COALESCE(handle, '') AS handle,
		COALESCE(external_user_id, '') AS external_user_id FROM accounts`+where+` ORDER BY is_default DESC, created_at LIMIT 1`, &rows)
	if err != nil {
		return accountRow{}, err
	}
	if len(rows) == 0 {
		return accountRow{}, fmt.Errorf("birdclaw account %q not found", requested)
	}
	return rows[0], nil
}

func sqliteJSON(ctx context.Context, dbPath, query string, target any) error {
	binary := strings.TrimSpace(os.Getenv("CUED_BIRDCLAW_SQLITE_BINARY"))
	if binary == "" {
		binary = "sqlite3"
	}
	cmd := exec.CommandContext(ctx, binary, "-json", dbPath, query) // #nosec G204 -- no shell is used.
	raw, err := cmd.Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return fmt.Errorf("birdclaw sqlite query: %s", strings.TrimSpace(string(exitErr.Stderr)))
		}
		return err
	}
	if strings.TrimSpace(string(raw)) == "" {
		raw = []byte("[]")
	}
	return json.Unmarshal(raw, target)
}

func resolveDBPath(value string) (string, error) {
	path := strings.TrimSpace(value)
	if path == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		path = filepath.Join(home, ".birdclaw", "birdclaw.sqlite")
	} else if strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		path = filepath.Join(home, strings.TrimPrefix(path, "~/"))
	}
	return filepath.Abs(path)
}

func quoteSQL(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func writeJSON(value any) {
	if err := json.NewEncoder(os.Stdout).Encode(value); err != nil {
		fail(err)
	}
}

func fail(err error) {
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": false, "error": err.Error()})
	os.Exit(1)
}
