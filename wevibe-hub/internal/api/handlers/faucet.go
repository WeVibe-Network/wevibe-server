package handlers

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"

	sdk "github.com/cosmos/cosmos-sdk/types"
)

const defaultFaucetFundAmount int64 = 1_000_000

type fundFromFaucetRequest struct {
	Address string `json:"address"`
	Amount  int64  `json:"amount"`
}

func FundFromFaucet(w http.ResponseWriter, r *http.Request) {
	if chainClient == nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req fundFromFaucetRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	address := strings.TrimSpace(req.Address)
	if address == "" {
		http.Error(w, `{"error":"address is required"}`, http.StatusBadRequest)
		return
	}
	decodedAddress, err := sdk.GetFromBech32(address, "wevibe")
	if err != nil || sdk.VerifyAddressFormat(decodedAddress) != nil {
		http.Error(w, `{"error":"address must be a valid bech32 address"}`, http.StatusBadRequest)
		return
	}

	amount := req.Amount
	if amount <= 0 {
		amount = defaultFaucetFundAmount
	}

	if strings.TrimSpace(faucetURL) == "" {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	if err := chainClient.FundAddressFromFaucet(r.Context(), faucetURL, address, amount); err != nil {
		log.Printf("ERROR: faucet funding failed: address=%s amount=%d err=%v", address, amount, err)
		http.Error(w, `{"error":"failed to fund address"}`, http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"address": address,
		"amount":  amount,
		"status":  "funded",
	})
}
