package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// connectionTracker records when the current WhatsApp websocket connection
// was established, for the Settings tab's "connected since" display.
type connectionTracker struct {
	mu             sync.Mutex
	connectedSince time.Time
}

func (t *connectionTracker) setConnected(connected bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if connected {
		t.connectedSince = time.Now()
	} else {
		t.connectedSince = time.Time{}
	}
}

func (t *connectionTracker) since() int64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.connectedSince.IsZero() {
		return 0
	}
	return t.connectedSince.Unix()
}

type statusResponse struct {
	Linked         bool   `json:"linked"`
	Phone          string `json:"phone,omitempty"`
	PushName       string `json:"pushName,omitempty"`
	ConnectedSince int64  `json:"connectedSince,omitempty"`
}

// startControlServer serves the MCP endpoint plus a small localhost-only
// control surface (status/QR/unlink) for the Node host to proxy into the
// Settings tab. No auth here by design — only reachable via 127.0.0.1, and
// only the authenticated Node routes forward to it.
func startControlServer(ts *toolServer, tracker *connectionTracker, dataDir string) {
	addr := os.Getenv("WA_MCP_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8765"
	}

	server := mcp.NewServer(&mcp.Implementation{Name: "whatsapp-sidecar", Version: "0.1.0"}, nil)
	registerTools(server, ts)
	mcpHandler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil)

	mux := http.NewServeMux()
	mux.Handle("/mcp", mcpHandler)

	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		resp := statusResponse{ConnectedSince: tracker.since()}
		if ts.client.Store.ID != nil {
			resp.Linked = true
			resp.Phone = ts.client.Store.ID.User
			resp.PushName = ts.client.Store.PushName
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})

	mux.HandleFunc("/qr.png", func(w http.ResponseWriter, r *http.Request) {
		if ts.client.Store.ID != nil {
			http.Error(w, "already linked", http.StatusConflict)
			return
		}
		http.ServeFile(w, r, filepath.Join(dataDir, "qr.png"))
	})

	mux.HandleFunc("/qr/refresh", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if ts.client.Store.ID != nil {
			http.Error(w, "already linked", http.StatusConflict)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		// The QR channel whatsmeow opened at boot only rotates a few times
		// before giving up ("timeout"), after which qr.png is stale forever
		// until a fresh GetQRChannel is opened — which only happens at
		// process start. Exit so the Node supervisor restarts us into a
		// brand-new pairing attempt.
		go func() {
			time.Sleep(300 * time.Millisecond)
			os.Exit(0)
		}()
	})

	mux.HandleFunc("/unlink", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := ts.client.Logout(ctx); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		// Exit so the Node supervisor restarts us fresh: GetFirstDevice will
		// create a brand-new (unpaired) device and generate a new QR.
		go func() {
			time.Sleep(300 * time.Millisecond)
			os.Exit(0)
		}()
	})

	fmt.Println("[control] listening on", addr, "(mcp at /mcp, status/qr.png/qr/refresh/unlink for the host)")
	if err := http.ListenAndServe(addr, mux); err != nil {
		fmt.Println("[error] control server stopped:", err)
	}
}
