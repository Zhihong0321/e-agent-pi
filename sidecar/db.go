package main

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

const schema = `
CREATE TABLE IF NOT EXISTS chats (
	jid TEXT PRIMARY KEY,
	name TEXT NOT NULL DEFAULT '',
	is_group INTEGER NOT NULL DEFAULT 0,
	last_message_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
	id TEXT PRIMARY KEY,
	chat_jid TEXT NOT NULL,
	sender_jid TEXT NOT NULL,
	from_me INTEGER NOT NULL DEFAULT 0,
	push_name TEXT NOT NULL DEFAULT '',
	text TEXT NOT NULL DEFAULT '',
	timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_jid, timestamp DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
	id UNINDEXED,
	chat_jid UNINDEXED,
	sender_jid UNINDEXED,
	from_me UNINDEXED,
	push_name UNINDEXED,
	timestamp UNINDEXED,
	text
);
`

func ensureSchema(db *sql.DB) error {
	_, err := db.Exec(schema)
	return err
}

type StoredMessage struct {
	ID        string
	ChatJID   string
	SenderJID string
	FromMe    bool
	PushName  string
	Text      string
	Timestamp int64
}

type ChatRow struct {
	JID           string `json:"jid"`
	Name          string `json:"name"`
	IsGroup       bool   `json:"is_group"`
	LastMessageAt int64  `json:"last_message_at"`
}

type MessageRow struct {
	ID        string `json:"id"`
	ChatJID   string `json:"chat_jid"`
	Sender    string `json:"sender"`
	FromMe    bool   `json:"from_me"`
	PushName  string `json:"push_name"`
	Text      string `json:"text"`
	Timestamp int64  `json:"timestamp"`
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// upsertChat stores or refreshes a chat's display name / last-activity time.
// An empty name never overwrites a previously known name.
func upsertChat(ctx context.Context, db *sql.DB, jid, name string, isGroup bool, lastMessageAt int64) error {
	_, err := db.ExecContext(ctx, `
		INSERT INTO chats (jid, name, is_group, last_message_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(jid) DO UPDATE SET
			name = CASE WHEN excluded.name != '' THEN excluded.name ELSE chats.name END,
			is_group = excluded.is_group,
			last_message_at = MAX(chats.last_message_at, excluded.last_message_at)
	`, jid, name, boolToInt(isGroup), lastMessageAt)
	return err
}

// upsertMessage stores a message once (keyed by WhatsApp message id) and
// mirrors it into the FTS index. Returns true if this was a new message.
func upsertMessage(ctx context.Context, db *sql.DB, msg StoredMessage) (bool, error) {
	res, err := db.ExecContext(ctx, `
		INSERT OR IGNORE INTO messages (id, chat_jid, sender_jid, from_me, push_name, text, timestamp)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`, msg.ID, msg.ChatJID, msg.SenderJID, boolToInt(msg.FromMe), msg.PushName, msg.Text, msg.Timestamp)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil || n == 0 {
		return false, err
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO messages_fts (id, chat_jid, sender_jid, from_me, push_name, timestamp, text)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`, msg.ID, msg.ChatJID, msg.SenderJID, boolToInt(msg.FromMe), msg.PushName, msg.Timestamp, msg.Text); err != nil {
		return false, err
	}
	isGroup := strings.HasSuffix(msg.ChatJID, "@g.us")
	name := ""
	if !msg.FromMe && !isGroup {
		name = msg.PushName
	}
	if err := upsertChat(ctx, db, msg.ChatJID, name, isGroup, msg.Timestamp); err != nil {
		return true, err
	}
	return true, nil
}

func listChats(ctx context.Context, db *sql.DB, limit int) ([]ChatRow, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT jid, name, is_group, last_message_at FROM chats
		ORDER BY last_message_at DESC LIMIT ?
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ChatRow
	for rows.Next() {
		var c ChatRow
		var isGroup int
		if err := rows.Scan(&c.JID, &c.Name, &isGroup, &c.LastMessageAt); err != nil {
			return nil, err
		}
		c.IsGroup = isGroup != 0
		out = append(out, c)
	}
	return out, rows.Err()
}

func findContacts(ctx context.Context, db *sql.DB, query string, limit int) ([]ChatRow, error) {
	like := "%" + query + "%"
	rows, err := db.QueryContext(ctx, `
		SELECT jid, name, is_group, last_message_at FROM chats
		WHERE name LIKE ? COLLATE NOCASE OR jid LIKE ?
		ORDER BY last_message_at DESC LIMIT ?
	`, like, like, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ChatRow
	for rows.Next() {
		var c ChatRow
		var isGroup int
		if err := rows.Scan(&c.JID, &c.Name, &isGroup, &c.LastMessageAt); err != nil {
			return nil, err
		}
		c.IsGroup = isGroup != 0
		out = append(out, c)
	}
	return out, rows.Err()
}

func readChat(ctx context.Context, db *sql.DB, chatJID string, limit int, before int64) ([]MessageRow, error) {
	var rows *sql.Rows
	var err error
	if before > 0 {
		rows, err = db.QueryContext(ctx, `
			SELECT id, chat_jid, sender_jid, from_me, push_name, text, timestamp FROM messages
			WHERE chat_jid = ? AND timestamp < ?
			ORDER BY timestamp DESC LIMIT ?
		`, chatJID, before, limit)
	} else {
		rows, err = db.QueryContext(ctx, `
			SELECT id, chat_jid, sender_jid, from_me, push_name, text, timestamp FROM messages
			WHERE chat_jid = ?
			ORDER BY timestamp DESC LIMIT ?
		`, chatJID, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMessages(rows)
}

func searchMessages(ctx context.Context, db *sql.DB, query, chatJID string, limit int) ([]MessageRow, error) {
	var rows *sql.Rows
	var err error
	if chatJID != "" {
		rows, err = db.QueryContext(ctx, `
			SELECT id, chat_jid, sender_jid, from_me, push_name, text, timestamp FROM messages_fts
			WHERE messages_fts MATCH ? AND chat_jid = ?
			ORDER BY timestamp DESC LIMIT ?
		`, query, chatJID, limit)
	} else {
		rows, err = db.QueryContext(ctx, `
			SELECT id, chat_jid, sender_jid, from_me, push_name, text, timestamp FROM messages_fts
			WHERE messages_fts MATCH ?
			ORDER BY timestamp DESC LIMIT ?
		`, query, limit)
	}
	if err != nil {
		return nil, fmt.Errorf("search failed (check FTS query syntax): %w", err)
	}
	defer rows.Close()
	return scanMessages(rows)
}

func scanMessages(rows *sql.Rows) ([]MessageRow, error) {
	var out []MessageRow
	for rows.Next() {
		var m MessageRow
		var fromMe int
		if err := rows.Scan(&m.ID, &m.ChatJID, &m.Sender, &fromMe, &m.PushName, &m.Text, &m.Timestamp); err != nil {
			return nil, err
		}
		m.FromMe = fromMe != 0
		out = append(out, m)
	}
	return out, rows.Err()
}

// resolveChat accepts either a raw JID or a name fragment and returns the
// best-matching chat JID, or an error listing candidates if ambiguous.
func resolveChat(ctx context.Context, db *sql.DB, input string) (string, error) {
	if strings.Contains(input, "@") {
		return input, nil
	}
	matches, err := findContacts(ctx, db, input, 5)
	if err != nil {
		return "", err
	}
	if len(matches) == 0 {
		return "", fmt.Errorf("no chat found matching %q", input)
	}
	if len(matches) > 1 {
		names := make([]string, len(matches))
		for i, m := range matches {
			names[i] = fmt.Sprintf("%s (%s)", m.Name, m.JID)
		}
		return "", fmt.Errorf("multiple chats match %q, be more specific: %s", input, strings.Join(names, ", "))
	}
	return matches[0].JID, nil
}
