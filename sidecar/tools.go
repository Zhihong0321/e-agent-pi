package main

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

// sendLimiter is a hard per-hour backstop on send_text, independent of
// whatever the agent's own role-instructions ask-before-send policy does.
type sendLimiter struct {
	mu    sync.Mutex
	sent  []time.Time
	limit int
}

func (l *sendLimiter) allow() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	cutoff := time.Now().Add(-1 * time.Hour)
	kept := l.sent[:0]
	for _, t := range l.sent {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	l.sent = kept
	if len(l.sent) >= l.limit {
		return false
	}
	l.sent = append(l.sent, time.Now())
	return true
}

type toolServer struct {
	db      *sql.DB
	client  *whatsmeow.Client
	limits  *sendLimiter
	dataDir string
}

func registerTools(s *mcp.Server, ts *toolServer) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "list_chats",
		Description: "List recent WhatsApp chats with name, id, and last message time.",
	}, ts.listChats)

	mcp.AddTool(s, &mcp.Tool{
		Name:        "find_contact",
		Description: "Resolve a name fragment to WhatsApp chat ids.",
	}, ts.findContact)

	mcp.AddTool(s, &mcp.Tool{
		Name:        "read_chat",
		Description: "Read the most recent messages of one WhatsApp chat, oldest-to-newest omitted (newest first). Pass the 'before' timestamp from the oldest returned message to page further back.",
	}, ts.readChat)

	mcp.AddTool(s, &mcp.Tool{
		Name:        "search_messages",
		Description: "Full-text search over stored WhatsApp messages, optionally scoped to one chat.",
	}, ts.searchMessages)

	mcp.AddTool(s, &mcp.Tool{
		Name:        "send_text",
		Description: "Send one text message to one WhatsApp chat. Only call this after the owner has explicitly approved the exact text in the current conversation.",
	}, ts.sendText)

	mcp.AddTool(s, &mcp.Tool{
		Name:        "remember",
		Description: "Save a custom instruction from the owner for next time (e.g. a standing preference or rule). Also shown to the owner in the Settings tab and editable there.",
	}, ts.remember)

	mcp.AddTool(s, &mcp.Tool{
		Name:        "save_contact",
		Description: "Save or update what you know about one contact that WhatsApp itself doesn't tell you — e.g. 'potential client', 'employee, accounts team'. Calling it again for the same contact replaces the old note.",
	}, ts.saveContact)
}

type listChatsArgs struct {
	Limit int `json:"limit,omitempty" jsonschema:"max number of chats to return, default 20"`
}

// MCP requires a tool's outputSchema (and therefore structuredContent) to be a
// JSON object at the top level; a bare slice's schema is `null | array`, which
// fails Pi's client-side validation and drops the whole server's connection.
// Every tool below returns a small named wrapper struct for this reason.
type listChatsResult struct {
	Chats []ChatRow `json:"chats"`
}

func (ts *toolServer) listChats(ctx context.Context, _ *mcp.CallToolRequest, args listChatsArgs) (*mcp.CallToolResult, listChatsResult, error) {
	limit := args.Limit
	if limit <= 0 {
		limit = 20
	}
	chats, err := listChats(ctx, ts.db, limit)
	if err != nil {
		return nil, listChatsResult{}, err
	}
	return nil, listChatsResult{Chats: chats}, nil
}

type findContactArgs struct {
	Query string `json:"query" jsonschema:"name fragment to search for"`
}

type findContactResult struct {
	Matches []ChatRow `json:"matches"`
}

func (ts *toolServer) findContact(ctx context.Context, _ *mcp.CallToolRequest, args findContactArgs) (*mcp.CallToolResult, findContactResult, error) {
	if args.Query == "" {
		return nil, findContactResult{}, fmt.Errorf("query is required")
	}
	matches, err := findContacts(ctx, ts.db, args.Query, 20)
	if err != nil {
		return nil, findContactResult{}, err
	}
	return nil, findContactResult{Matches: matches}, nil
}

type readChatArgs struct {
	Chat   string `json:"chat" jsonschema:"chat id (from list_chats/find_contact) or a name fragment"`
	Limit  int    `json:"limit,omitempty" jsonschema:"max number of messages to return, default 20"`
	Before int64  `json:"before,omitempty" jsonschema:"only return messages before this unix-seconds timestamp, for paging further back"`
}

type readChatResult struct {
	Messages []MessageRow `json:"messages"`
}

func (ts *toolServer) readChat(ctx context.Context, _ *mcp.CallToolRequest, args readChatArgs) (*mcp.CallToolResult, readChatResult, error) {
	if args.Chat == "" {
		return nil, readChatResult{}, fmt.Errorf("chat is required")
	}
	jid, err := resolveChat(ctx, ts.db, args.Chat)
	if err != nil {
		return nil, readChatResult{}, err
	}
	limit := args.Limit
	if limit <= 0 {
		limit = 20
	}
	msgs, err := readChat(ctx, ts.db, jid, limit, args.Before)
	if err != nil {
		return nil, readChatResult{}, err
	}
	return nil, readChatResult{Messages: msgs}, nil
}

type searchMessagesArgs struct {
	Query string `json:"query" jsonschema:"full-text search query"`
	Chat  string `json:"chat,omitempty" jsonschema:"optional chat id or name fragment to restrict the search to"`
	Limit int    `json:"limit,omitempty" jsonschema:"max number of messages to return, default 20"`
}

type searchMessagesResult struct {
	Messages []MessageRow `json:"messages"`
}

func (ts *toolServer) searchMessages(ctx context.Context, _ *mcp.CallToolRequest, args searchMessagesArgs) (*mcp.CallToolResult, searchMessagesResult, error) {
	if args.Query == "" {
		return nil, searchMessagesResult{}, fmt.Errorf("query is required")
	}
	chatJID := ""
	if args.Chat != "" {
		jid, err := resolveChat(ctx, ts.db, args.Chat)
		if err != nil {
			return nil, searchMessagesResult{}, err
		}
		chatJID = jid
	}
	limit := args.Limit
	if limit <= 0 {
		limit = 20
	}
	msgs, err := searchMessages(ctx, ts.db, args.Query, chatJID, limit)
	if err != nil {
		return nil, searchMessagesResult{}, err
	}
	return nil, searchMessagesResult{Messages: msgs}, nil
}

type sendTextArgs struct {
	Chat string `json:"chat" jsonschema:"chat id (from list_chats/find_contact) or a name fragment"`
	Text string `json:"text" jsonschema:"the exact text to send"`
}

type sendTextResult struct {
	Sent      bool   `json:"sent"`
	Timestamp int64  `json:"timestamp,omitempty"`
	ChatJID   string `json:"chat_jid,omitempty"`
}

func (ts *toolServer) sendText(ctx context.Context, _ *mcp.CallToolRequest, args sendTextArgs) (*mcp.CallToolResult, sendTextResult, error) {
	if args.Chat == "" || args.Text == "" {
		return nil, sendTextResult{}, fmt.Errorf("chat and text are required")
	}
	if !ts.limits.allow() {
		return nil, sendTextResult{}, fmt.Errorf("hourly send cap reached, try again later")
	}
	jidStr, err := resolveChat(ctx, ts.db, args.Chat)
	if err != nil {
		return nil, sendTextResult{}, err
	}
	jid, err := types.ParseJID(jidStr)
	if err != nil {
		return nil, sendTextResult{}, fmt.Errorf("invalid chat id %q: %w", jidStr, err)
	}
	resp, err := ts.client.SendMessage(ctx, jid, &waE2E.Message{
		Conversation: proto.String(args.Text),
	})
	if err != nil {
		return nil, sendTextResult{}, fmt.Errorf("send failed: %w", err)
	}
	senderJID := resp.Sender
	if senderJID.IsEmpty() && ts.client.Store.ID != nil {
		senderJID = *ts.client.Store.ID
	}
	if _, err := upsertMessage(ctx, ts.db, StoredMessage{
		ID:        resp.ID,
		ChatJID:   jidStr,
		SenderJID: senderJID.String(),
		FromMe:    true,
		Text:      args.Text,
		Timestamp: resp.Timestamp.Unix(),
	}); err != nil {
		fmt.Println("[error] failed to store sent message:", err)
	}
	return nil, sendTextResult{Sent: true, Timestamp: resp.Timestamp.Unix(), ChatJID: jidStr}, nil
}

type rememberArgs struct {
	Note string `json:"note" jsonschema:"the instruction or fact to remember, in your own words"`
}

type rememberResult struct {
	Saved  bool   `json:"saved"`
	Memory string `json:"memory" jsonschema:"the full updated memory.md content"`
}

func (ts *toolServer) remember(ctx context.Context, _ *mcp.CallToolRequest, args rememberArgs) (*mcp.CallToolResult, rememberResult, error) {
	if strings.TrimSpace(args.Note) == "" {
		return nil, rememberResult{}, fmt.Errorf("note is required")
	}
	content, err := appendMarkdownBullet(filepath.Join(ts.dataDir, "memory.md"), args.Note)
	if err != nil {
		return nil, rememberResult{}, err
	}
	return nil, rememberResult{Saved: true, Memory: content}, nil
}

type saveContactArgs struct {
	Contact string `json:"contact" jsonschema:"the contact's name or phone number/JID, as you'd refer to them"`
	Note    string `json:"note" jsonschema:"what to remember about this contact, e.g. 'potential client', 'employee - accounts team'"`
}

type saveContactResult struct {
	Saved    bool   `json:"saved"`
	Contacts string `json:"contacts" jsonschema:"the full updated contacts.md content"`
}

func (ts *toolServer) saveContact(ctx context.Context, _ *mcp.CallToolRequest, args saveContactArgs) (*mcp.CallToolResult, saveContactResult, error) {
	if strings.TrimSpace(args.Contact) == "" || strings.TrimSpace(args.Note) == "" {
		return nil, saveContactResult{}, fmt.Errorf("contact and note are required")
	}
	content, err := upsertContactNote(filepath.Join(ts.dataDir, "contacts.md"), args.Contact, args.Note)
	if err != nil {
		return nil, saveContactResult{}, err
	}
	return nil, saveContactResult{Saved: true, Contacts: content}, nil
}
