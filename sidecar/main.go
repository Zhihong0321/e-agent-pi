// Phase 0 of the WhatsApp sidecar: pair by QR, log every message, reconnect
// on restart without a new QR. See whatsapp-auto-plan.md for the full plan.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/mdp/qrterminal/v3"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store/sqlstore"
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

	dbPath := filepath.ToSlash(filepath.Join(dataDir, "whatsapp.db"))
	dbLog := waLog.Stdout("Database", "INFO", true)
	dsn := fmt.Sprintf("file:%s?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)", dbPath)
	container, err := sqlstore.New(context.Background(), "sqlite", dsn, dbLog)
	if err != nil {
		panic(err)
	}

	deviceStore, err := container.GetFirstDevice(context.Background())
	if err != nil {
		panic(err)
	}

	clientLog := waLog.Stdout("Client", "INFO", true)
	client := whatsmeow.NewClient(deviceStore, clientLog)

	client.AddEventHandler(func(evt interface{}) {
		switch v := evt.(type) {
		case *events.Message:
			logMessage(v)
		case *events.HistorySync:
			total := 0
			for _, conv := range v.Data.GetConversations() {
				total += len(conv.GetMessages())
			}
			fmt.Printf("[history-sync] chunk order=%d progress=%d%% conversations=%d messages=%d\n",
				v.Data.GetChunkOrder(), v.Data.GetProgress(), len(v.Data.GetConversations()), total)
		case *events.Connected:
			fmt.Println("[status] connected")
		case *events.Disconnected:
			fmt.Println("[status] disconnected")
		case *events.LoggedOut:
			fmt.Println("[status] logged out — delete", dbPath, "and restart to pair again")
		}
	})

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
