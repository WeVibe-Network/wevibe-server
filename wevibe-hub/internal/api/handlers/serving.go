package handlers

import (
	"encoding/json"
	"net/http"
)

func GetServingAddress(w http.ResponseWriter, r *http.Request) {
	if chainClient == nil {
		http.Error(w, `{"error":"chain client unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"serving_address": chainClient.SubmitterAddress(),
	})
}
