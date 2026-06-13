package handlers

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

var (
	healthInstanceIDOnce sync.Once
	healthInstanceID     string
)

type HealthResponse struct {
	Status     string    `json:"status"`
	Timestamp  time.Time `json:"timestamp"`
	Version    string    `json:"version"`
	DB         string    `json:"db"`
	InstanceID string    `json:"instanceId"`
}

func Health(w http.ResponseWriter, r *http.Request) {
	dbStatus := "disconnected"
	if pool != nil {
		if err := pool.Ping(r.Context()); err == nil {
			dbStatus = "connected"
		}

		healthInstanceIDOnce.Do(func() {
			_ = pool.QueryRow(r.Context(), "SELECT instance_id::text FROM hub_instance WHERE id = 1").Scan(&healthInstanceID)
		})
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(HealthResponse{
		Status:     "ok",
		Timestamp:  time.Now().UTC(),
		Version:    "0.2.0",
		DB:         dbStatus,
		InstanceID: healthInstanceID,
	})
}
