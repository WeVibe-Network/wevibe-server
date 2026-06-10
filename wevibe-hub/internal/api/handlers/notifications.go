package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/gorilla/websocket"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/notifications"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
)

var notificationHub *notifications.NotificationHub
var notificationDispatcher *notifications.Dispatcher

func SetNotificationHub(h *notifications.NotificationHub) {
	notificationHub = h
}

func GetNotificationHub() *notifications.NotificationHub {
	return notificationHub
}

func SetNotificationDispatcher(d *notifications.Dispatcher) {
	notificationDispatcher = d
}

type NotificationResponse struct {
	ID        int64  `json:"id"`
	Category  string `json:"category"`
	Title     string `json:"title"`
	Body      string `json:"body"`
	EventRef  string `json:"event_ref"`
	OrgID     string `json:"org_id"`
	OrgName   string `json:"org_name"`
	Route     string `json:"route"`
	Read      bool   `json:"read"`
	CreatedAt string `json:"created_at"`
}

type ListNotificationsResponse struct {
	Notifications []NotificationResponse `json:"notifications"`
	HasMore       bool                   `json:"has_more"`
}

func ListNotifications(w http.ResponseWriter, r *http.Request) {
	auth, err := auth.ParseWeVibeSigned(r)
	if err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	limitStr := r.URL.Query().Get("limit")
	limit := 50
	if limitStr != "" {
		if l, err := strconv.Atoi(limitStr); err == nil && l > 0 && l <= 200 {
			limit = l
		}
	}

	beforeStr := r.URL.Query().Get("before")
	unreadOnly := r.URL.Query().Get("unread_only") == "true"

	query := `
		SELECT n.id, n.category, n.title, n.body, n.event_ref, n.org_id, COALESCE(o.org_name, ''), COALESCE(n.route, ''), n.read, n.created_at
		FROM notifications n
		LEFT JOIN orgs o ON n.org_id = o.org_id
		WHERE n.recipient_pubkey = $1
	`
	args := []interface{}{auth.Pubkey}
	argIdx := 2

	if unreadOnly {
		query += " AND n.read = false"
	}

	if beforeStr != "" {
		beforeID, err := strconv.ParseInt(beforeStr, 10, 64)
		if err == nil {
			query += " AND n.id < $" + strconv.Itoa(argIdx)
			args = append(args, beforeID)
			argIdx++
		}
	}

	query += " ORDER BY n.created_at DESC, n.id DESC LIMIT $" + strconv.Itoa(argIdx)
	args = append(args, limit+1)

	rows, err := pool.Query(r.Context(), query, args...)
	if err != nil {
		http.Error(w, `{"error":"database error"}`, http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	notifications := []NotificationResponse{}
	for rows.Next() {
		var n NotificationResponse
		var createdAt time.Time
		if err := rows.Scan(&n.ID, &n.Category, &n.Title, &n.Body, &n.EventRef, &n.OrgID, &n.OrgName, &n.Route, &n.Read, &createdAt); err != nil {
			continue
		}
		n.CreatedAt = createdAt.Format(time.RFC3339)
		notifications = append(notifications, n)
	}

	hasMore := len(notifications) > limit
	if hasMore {
		notifications = notifications[:limit]
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(ListNotificationsResponse{
		Notifications: notifications,
		HasMore:       hasMore,
	})
}

type UnreadCountResponse struct {
	Count int64 `json:"count"`
}

func GetUnreadCount(w http.ResponseWriter, r *http.Request) {
	auth, err := auth.ParseWeVibeSigned(r)
	if err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	var count int64
	err = pool.QueryRow(r.Context(), `
		SELECT COUNT(*) FROM notifications WHERE recipient_pubkey = $1 AND read = false
	`, auth.Pubkey).Scan(&count)
	if err != nil {
		http.Error(w, `{"error":"database error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(UnreadCountResponse{Count: count})
}

type MarkReadRequest struct {
	NotificationIDs []int64 `json:"notification_ids,omitempty"`
	All             bool    `json:"all,omitempty"`
}

type MarkReadResponse struct {
	Marked int64 `json:"marked"`
}

func MarkRead(w http.ResponseWriter, r *http.Request) {
	auth, err := auth.ParseWeVibeSigned(r)
	if err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	var req MarkReadRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	var marked int64
	if req.All {
		result, err := pool.Exec(r.Context(), `
			UPDATE notifications SET read = true WHERE recipient_pubkey = $1 AND read = false
		`, auth.Pubkey)
		if err != nil {
			http.Error(w, `{"error":"database error"}`, http.StatusInternalServerError)
			return
		}
		marked = result.RowsAffected()
	} else if len(req.NotificationIDs) > 0 {
		result, err := pool.Exec(r.Context(), `
			UPDATE notifications SET read = true WHERE recipient_pubkey = $1 AND id = ANY($2) AND read = false
		`, auth.Pubkey, req.NotificationIDs)
		if err != nil {
			http.Error(w, `{"error":"database error"}`, http.StatusInternalServerError)
			return
		}
		marked = result.RowsAffected()
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(MarkReadResponse{Marked: marked})
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
}

type WSAuthMessage struct {
	Pubkey    string `json:"pubkey"`
	Timestamp string `json:"timestamp"`
	Signature string `json:"signature"`
}

type WSMessage struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data,omitempty"`
}

func NotificationWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	client := &notifications.Client{
		Conn: conn,
		Send: make(chan []byte, 256),
	}

	go func() {
		defer conn.Close()
		for {
			_, message, err := conn.ReadMessage()
			if err != nil {
				if notificationHub != nil {
					notificationHub.Unregister(client)
				}
				return
			}

			var msg WSMessage
			if err := json.Unmarshal(message, &msg); err != nil {
				continue
			}

			switch msg.Type {
			case "auth":
				var authMsg WSAuthMessage
				if err := json.Unmarshal(msg.Data, &authMsg); err != nil {
					conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"error","data":"invalid auth message"}`))
					conn.Close()
					return
				}

				if authMsg.Pubkey == "" || authMsg.Signature == "" {
					conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"error","data":"missing auth fields"}`))
					conn.Close()
					return
				}

				if authMsg.Timestamp == "" {
					conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"error","data":"missing auth timestamp"}`))
					conn.Close()
					return
				}

				ts, err := time.Parse(time.RFC3339, authMsg.Timestamp)
				if err != nil {
					conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"error","data":"invalid timestamp format, use RFC3339"}`))
					conn.Close()
					return
				}

				now := time.Now()
				if now.Sub(ts) > 5*time.Minute || ts.Sub(now) > 5*time.Minute {
					conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"error","data":"timestamp expired or too far in future"}`))
					conn.Close()
					return
				}

				if err := verify.RequestSignature(authMsg.Pubkey, authMsg.Signature, []byte(authMsg.Timestamp)); err != nil {
					conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"error","data":"unauthorized"}`))
					conn.Close()
					return
				}

				client.Pubkey = authMsg.Pubkey
				if notificationHub != nil {
					notificationHub.Register(client)
					conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"auth_success"}`))
				} else {
					conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"error","data":"hub unavailable"}`))
					conn.Close()
					return
				}

			case "ping":
				conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"pong"}`))
			}
		}
	}()

	go func() {
		defer conn.Close()
		for payload := range client.Send {
			if err := conn.WriteMessage(websocket.TextMessage, payload); err != nil {
				return
			}
		}
	}()
}
