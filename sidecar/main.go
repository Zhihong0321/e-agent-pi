// WhatsApp sidecar: pairs by QR, stores history + live messages in SQLite
// with full-text search, and exposes five MCP tools over HTTP. See
// whatsapp-auto-plan.md for the full plan and phase breakdown.
package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/mdp/qrterminal/v3"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	_ "modernc.org/sqlite"
	"rsc.io/qr"
)

func main() {
	dataDir := os.Getenv("WA_DATA_DIR")
	if dataDir == "" {
		dataDir = "./data"
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		panic(err)
	}

	sessionDSN := sqliteDSN(filepath.Join(dataDir, "whatsapp.db"))
	dbLog := waLog.Stdout("Database", "INFO", true)
	container, err := sqlstore.New(context.Background(), "sqlite", sessionDSN, dbLog)
	if err != nil {
		panic(err)
	}

	deviceStore, err := container.GetFirstDevice(context.Background())
	if err != nil {
		panic(err)
	}

	messagesDB, err := sql.Open("sqlite", sqliteDSN(filepath.Join(dataDir, "messages.db")))
	if err != nil {
		panic(err)
	}
	if err := ensureSchema(messagesDB); err != nil {
		panic(err)
	}

	clientLog := waLog.Stdout("Client", "INFO", true)
	client := whatsmeow.NewClient(deviceStore, clientLog)
	tracker := &connectionTracker{}

	dbPath := filepath.Join(dataDir, "whatsapp.db")
	client.AddEventHandler(func(evt interface{}) {
		switch v := evt.(type) {
		case *events.Message:
			logMessage(v)
			ctx := context.Background()
			if _, err := upsertMessage(ctx, messagesDB, toStoredMessage(v)); err != nil {
				fmt.Println("[error] failed to store message:", err)
			}
			refreshChatName(ctx, client, messagesDB, v.Info.Chat.String(), v.Info.IsGroup)
		case *events.HistorySync:
			handleHistorySync(client, messagesDB, v)
		case *events.Connected:
			tracker.setConnected(true)
			fmt.Println("[status] connected")
		case *events.Disconnected:
			tracker.setConnected(false)
			fmt.Println("[status] disconnected")
		case *events.LoggedOut:
			fmt.Println("[status] logged out — delete", dbPath, "and restart to pair again")
		}
	})

	backfillChatNames(client, messagesDB)

	limiter := &sendLimiter{limit: sendHourlyCap()}
	ts := &toolServer{db: messagesDB, client: client, limits: limiter}
	go startControlServer(ts, tracker, dataDir)

	if client.Store.ID == nil {
		qrChan, _ := client.GetQRChannel(context.Background())
		if err := client.Connect(); err != nil {
			panic(err)
		}
		for evt := range qrChan {
			if evt.Event == "code" {
				fmt.Println("Scan this QR code with WhatsApp (Linked Devices):")
				qrterminal.GenerateHalfBlock(evt.Code, qrterminal.L, os.Stdout)
				if code, err := qr.Encode(evt.Code, qr.L); err == nil {
					pngPath := filepath.Join(dataDir, "qr.png")
					if err := os.WriteFile(pngPath, code.PNG(), 0o644); err == nil {
						fmt.Println("QR image saved to", pngPath)
					}
				}
			} else {
				fmt.Println("[login]", evt.Event)
			}
		}
	} else {
		if err := client.Connect(); err != nil {
			panic(err)
		}
	}

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	<-sigChan
	client.Disconnect()
}

func sqliteDSN(path string) string {
	return fmt.Sprintf("file:%s?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)",
		filepath.ToSlash(path))
}

func isGroupJID(jidStr string) bool {
	return strings.HasSuffix(jidStr, "@g.us")
}

func parseJIDOrEmpty(jidStr string) (types.JID, error) {
	return types.ParseJID(jidStr)
}

// refreshChatName fills in a 1:1 chat's display name from whatsmeow's own
// contact cache (populated from history sync and live push names), without
// overwriting a name we've already resolved.
func refreshChatName(ctx context.Context, client *whatsmeow.Client, db *sql.DB, jidStr string, isGroup bool) {
	if isGroup || jidStr == "" {
		return
	}
	jid, err := types.ParseJID(jidStr)
	if err != nil {
		return
	}
	if client.Store.ID != nil && jid.User == client.Store.ID.User {
		name := client.Store.PushName
		if name == "" {
			name = "You"
		}
		if err := upsertChat(ctx, db, jidStr, name, false, 0); err != nil {
			fmt.Println("[error] failed to refresh chat name:", err)
		}
		return
	}
	lookupJID := jid
	if jid.Server == types.HiddenUserServer {
		if pn, err := client.Store.LIDs.GetPNForLID(ctx, jid); err == nil && !pn.IsEmpty() {
			lookupJID = pn
		}
	}
	info, err := client.Store.Contacts.GetContact(ctx, lookupJID)
	if err != nil || !info.Found {
		return
	}
	name := info.FullName
	if name == "" {
		name = info.PushName
	}
	if name == "" {
		name = info.BusinessName
	}
	if name == "" {
		return
	}
	if err := upsertChat(ctx, db, jidStr, name, false, 0); err != nil {
		fmt.Println("[error] failed to refresh chat name:", err)
	}
}

// backfillChatNames re-resolves names for chats stored before we started
// consulting whatsmeow's contact cache, or before that cache was populated.
func backfillChatNames(client *whatsmeow.Client, db *sql.DB) {
	ctx := context.Background()
	rows, err := db.QueryContext(ctx, `SELECT jid FROM chats WHERE name = '' AND is_group = 0`)
	if err != nil {
		fmt.Println("[error] backfill query failed:", err)
		return
	}
	var jids []string
	for rows.Next() {
		var jid string
		if err := rows.Scan(&jid); err == nil {
			jids = append(jids, jid)
		}
	}
	rows.Close()
	for _, jid := range jids {
		refreshChatName(ctx, client, db, jid, false)
	}
}

func sendHourlyCap() int {
	if v := os.Getenv("WA_SEND_HOURLY_CAP"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return 20
}

func handleHistorySync(client *whatsmeow.Client, db *sql.DB, v *events.HistorySync) {
	ctx := context.Background()
	total := 0
	for _, conv := range v.Data.GetConversations() {
		isGroup := isGroupJID(conv.GetID())
		if err := upsertChat(ctx, db, conv.GetID(), conv.GetName(), isGroup, int64(conv.GetConversationTimestamp())); err != nil {
			fmt.Println("[error] failed to store chat:", err)
		}
		refreshChatName(ctx, client, db, conv.GetID(), isGroup)
		chatJID, err := parseJIDOrEmpty(conv.GetID())
		if err != nil {
			continue
		}
		for _, historyMsg := range conv.GetMessages() {
			evt, err := client.ParseWebMessage(chatJID, historyMsg.GetMessage())
			if err != nil {
				continue
			}
			if _, err := upsertMessage(ctx, db, toStoredMessage(evt)); err != nil {
				fmt.Println("[error] failed to store history message:", err)
			}
			total++
		}
	}
	fmt.Printf("[history-sync] chunk order=%d progress=%d%% conversations=%d messages=%d\n",
		v.Data.GetChunkOrder(), v.Data.GetProgress(), len(v.Data.GetConversations()), total)
}

func toStoredMessage(evt *events.Message) StoredMessage {
	return StoredMessage{
		ID:        evt.Info.ID,
		ChatJID:   evt.Info.Chat.String(),
		SenderJID: evt.Info.Sender.String(),
		FromMe:    evt.Info.IsFromMe,
		PushName:  evt.Info.PushName,
		Text:      extractText(evt),
		Timestamp: evt.Info.Timestamp.Unix(),
	}
}

func logMessage(evt *events.Message) {
	direction := "in"
	if evt.Info.IsFromMe {
		direction = "out"
	}
	text := extractText(evt)
	fmt.Printf("[msg-%s] chat=%s sender=%s (%s): %s\n",
		direction, evt.Info.Chat, evt.Info.Sender, evt.Info.PushName, text)
}

func extractText(evt *events.Message) string {
	if evt.Message == nil {
		return "[no content]"
	}
	if text := evt.Message.GetConversation(); text != "" {
		return text
	}
	if ext := evt.Message.GetExtendedTextMessage(); ext.GetText() != "" {
		return ext.GetText()
	}
	if img := evt.Message.GetImageMessage(); img != nil {
		return "[image] " + img.GetCaption()
	}
	if vid := evt.Message.GetVideoMessage(); vid != nil {
		return "[video] " + vid.GetCaption()
	}
	if doc := evt.Message.GetDocumentMessage(); doc != nil {
		return "[document] " + doc.GetCaption()
	}
	if evt.Message.GetAudioMessage() != nil {
		return "[audio]"
	}
	return "[unsupported message type]"
}
