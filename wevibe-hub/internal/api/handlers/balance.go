package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/go-chi/chi/v5"
)

func GetBalance(w http.ResponseWriter, r *http.Request) {
	if chainClient == nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	address := strings.TrimSpace(chi.URLParam(r, "address"))
	if address == "" {
		http.Error(w, `{"error":"address is required"}`, http.StatusBadRequest)
		return
	}
	if _, err := sdk.AccAddressFromBech32(address); err != nil {
		http.Error(w, `{"error":"invalid address"}`, http.StatusBadRequest)
		return
	}

	denom, amount, err := chainClient.GetBalance(r.Context(), address)
	if err != nil {
		log.Printf("ERROR: balance query failed: address=%s err=%v", address, err)
		http.Error(w, `{"error":"failed to fetch balance"}`, http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"address": address,
		"denom":   denom,
		"amount":  amount,
	})
}
