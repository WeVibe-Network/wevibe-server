package notifications

import (
	"encoding/json"
	"sync"

	"github.com/gorilla/websocket"
)

type NotificationHub struct {
	mu      sync.RWMutex
	clients map[string]map[*Client]struct{}
}

type Client struct {
	Pubkey string
	Conn   *websocket.Conn
	Send   chan []byte
}

type NotificationMessage struct {
	Type string      `json:"type"`
	Data interface{} `json:"data"`
}

func NewHub() *NotificationHub {
	return &NotificationHub{
		clients: make(map[string]map[*Client]struct{}),
	}
}

func (h *NotificationHub) Register(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.clients[client.Pubkey]; !ok {
		h.clients[client.Pubkey] = make(map[*Client]struct{})
	}
	h.clients[client.Pubkey][client] = struct{}{}
}

func (h *NotificationHub) Unregister(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if clients, ok := h.clients[client.Pubkey]; ok {
		delete(clients, client)
		if len(clients) == 0 {
			delete(h.clients, client.Pubkey)
		}
	}
	close(client.Send)
}

func (h *NotificationHub) Broadcast(pubkey string, payload []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if clients, ok := h.clients[pubkey]; ok {
		for client := range clients {
			select {
			case client.Send <- payload:
			default:
				go func(c *Client) {
					h.Unregister(c)
				}(client)
			}
		}
	}
}

func (h *NotificationHub) ClientCount(pubkey string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if clients, ok := h.clients[pubkey]; ok {
		return len(clients)
	}
	return 0
}

type NotificationPayload struct {
	ID        int64  `json:"id"`
	Category  string `json:"category"`
	Title     string `json:"title"`
	Body      string `json:"body"`
	EventRef  string `json:"event_ref"`
	OrgID     string `json:"org_id"`
	OrgName   string `json:"org_name"`
	Read      bool   `json:"read"`
	CreatedAt string `json:"created_at"`
}

func NewNotificationMessage(payload *NotificationPayload) ([]byte, error) {
	msg := NotificationMessage{
		Type: "notification",
		Data: payload,
	}
	return json.Marshal(msg)
}
