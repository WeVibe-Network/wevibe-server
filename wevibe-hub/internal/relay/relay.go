package relay

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/cosmos/cosmos-sdk/types"
	authztypes "github.com/cosmos/cosmos-sdk/x/authz"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/chain"
)

var (
	pool        *pgxpool.Pool
	chainClient *chain.GrpcClient
	logger      *slog.Logger
)

func SetDeps(p *pgxpool.Pool, c *chain.GrpcClient, l *slog.Logger) {
	pool = p
	chainClient = c
	logger = l
}

type BroadcastTxResponse struct {
	TxHash string `json:"tx_hash"`
	Code   uint32 `json:"code"`
	RawLog string `json:"raw_log"`
	Height int64  `json:"height"`
}

func RelayBroadcast(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database_unavailable","detail":"database connection not initialized"}`, http.StatusServiceUnavailable)
		return
	}
	if chainClient == nil {
		http.Error(w, `{"error":"chain_client_unavailable","detail":"chain client not initialized"}`, http.StatusServiceUnavailable)
		return
	}

	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		http.Error(w, `{"error":"unauthorized","detail":"missing Authorization header"}`, http.StatusUnauthorized)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad_request","detail":"failed to read request body"}`, http.StatusBadRequest)
		return
	}

	orgID, walletAddr, txBytesB64, err := ParseCanonicalBody(body)
	if err != nil {
		detail := err.Error()
		if errors.Is(err, ErrWrongHeader) {
			detail = "canonical body must start with WV-RELAY-v1"
		}
		http.Error(w, fmt.Sprintf(`{"error":"bad_request","detail":"%s"}`, detail), http.StatusBadRequest)
		return
	}

	txBytes, err := base64.StdEncoding.DecodeString(txBytesB64)
	if err != nil {
		http.Error(w, `{"error":"bad_request","detail":"tx_bytes_base64 is not valid base64"}`, http.StatusBadRequest)
		return
	}

	txInstance, err := decodeTx(chainClient, txBytes)
	if err != nil {
		http.Error(w, `{"error":"bad_request","detail":"failed to decode tx bytes"}`, http.StatusBadRequest)
		return
	}

	// D-S32-CO044-LEADER-DUAL-PATH: two leader-signing paths, dispatched by
	// Authorization scheme. Both put the leader wallet as the on-chain
	// authority; the hub only transports. This intentionally maintains two
	// paths (explicit R-ONE-PATH exception for CO-044).
	const (
		delegatePrefix = "Delegate "
		walletPrefix   = "Wallet "
	)

	switch {
	case strings.HasPrefix(authHeader, walletPrefix):
		sigB64 := strings.TrimSpace(authHeader[len(walletPrefix):])
		if !handleDirectRelay(w, txInstance, walletAddr, string(body), sigB64) {
			return
		}
	case strings.HasPrefix(authHeader, delegatePrefix):
		sigB64 := strings.TrimSpace(authHeader[len(delegatePrefix):])
		if !handleDelegateRelay(w, txInstance, walletAddr, string(body), sigB64) {
			return
		}
	default:
		http.Error(w, `{"error":"unauthorized","detail":"invalid authorization scheme, expected 'Delegate <signature>' or 'Wallet <signature>'"}`, http.StatusUnauthorized)
		return
	}

	broadcastAndRespond(w, r, txBytes, orgID)
}

// handleDirectRelay authenticates a directly leader-signed tx (non-delegate
// path). Returns true to proceed to broadcast, false if it already wrote an
// error response.
func handleDirectRelay(w http.ResponseWriter, tx types.Tx, walletAddr, canonicalBody, sigB64 string) bool {
	if sigB64 == "" {
		http.Error(w, `{"error":"unauthorized","detail":"missing signature in Authorization header"}`, http.StatusUnauthorized)
		return false
	}

	if _, err := VerifyWalletSignature(tx, walletAddr, canonicalBody, sigB64); err != nil {
		detail := "invalid wallet signature"
		if errors.Is(err, ErrSignerMismatch) {
			detail = "tx signer does not match wallet_address"
		} else if errors.Is(err, ErrMultipleSigners) {
			detail = "direct relay tx must have exactly one signer"
		} else if errors.Is(err, ErrNotSigVerifiable) {
			detail = "tx is not signature-verifiable"
		}
		http.Error(w, fmt.Sprintf(`{"error":"unauthorized","detail":"%s"}`, detail), http.StatusUnauthorized)
		return false
	}

	if err := ValidateDirectMsgs(tx, walletAddr); err != nil {
		if errors.Is(err, ErrSignerMismatch) {
			http.Error(w, `{"error":"forbidden","detail":"message signer does not match wallet_address"}`, http.StatusForbidden)
			return false
		}
		if strings.Contains(err.Error(), ErrDisallowedType.Error()) {
			http.Error(w, `{"error":"bad_request","detail":"message type not allowed for relay"}`, http.StatusBadRequest)
			return false
		}
		http.Error(w, fmt.Sprintf(`{"error":"bad_request","detail":"%s"}`, err.Error()), http.StatusBadRequest)
		return false
	}

	return true
}

// handleDelegateRelay authenticates a delegate-signed authz MsgExec tx (the
// original relay path). Returns true to proceed to broadcast.
func handleDelegateRelay(w http.ResponseWriter, tx types.Tx, walletAddr, canonicalBody, sigB64 string) bool {
	if sigB64 == "" {
		http.Error(w, `{"error":"unauthorized","detail":"missing signature in Authorization header"}`, http.StatusUnauthorized)
		return false
	}

	if err := VerifyDelegateSignature(pool, walletAddr, canonicalBody, sigB64); err != nil {
		detail := "invalid or expired delegate signature"
		if errors.Is(err, ErrNoDelegateKey) {
			detail = "no active delegate key found for wallet"
		} else if errors.Is(err, ErrExpiredDelegate) {
			detail = "delegate key has expired"
		}
		http.Error(w, fmt.Sprintf(`{"error":"unauthorized","detail":"%s"}`, detail), http.StatusUnauthorized)
		return false
	}

	msgs := tx.GetMsgs()
	if len(msgs) != 1 {
		http.Error(w, `{"error":"bad_request","detail":"tx must contain exactly one message"}`, http.StatusBadRequest)
		return false
	}

	execMsg, ok := msgs[0].(*authztypes.MsgExec)
	if !ok {
		http.Error(w, `{"error":"bad_request","detail":"tx message must be MsgExec"}`, http.StatusBadRequest)
		return false
	}

	granter, err := ExtractInnerGranter(execMsg, chainClient.GetCodec())
	if err != nil {
		if errors.Is(err, ErrGranterMismatch) {
			http.Error(w, `{"error":"forbidden","detail":"inner messages have different granters"}`, http.StatusForbidden)
			return false
		}
		if errors.Is(err, ErrNoMsgsInExec) {
			http.Error(w, `{"error":"bad_request","detail":"MsgExec contains no messages"}`, http.StatusBadRequest)
			return false
		}
		if strings.Contains(err.Error(), ErrDisallowedType.Error()) {
			http.Error(w, `{"error":"bad_request","detail":"inner message type not allowed for relay"}`, http.StatusBadRequest)
			return false
		}
		http.Error(w, fmt.Sprintf(`{"error":"bad_request","detail":"%s"}`, err.Error()), http.StatusBadRequest)
		return false
	}

	if granter != walletAddr {
		http.Error(w, `{"error":"forbidden","detail":"granter does not match wallet_address"}`, http.StatusForbidden)
		return false
	}

	for _, msgAny := range execMsg.Msgs {
		if !IsRelayAllowed(msgAny.TypeUrl) {
			http.Error(w, fmt.Sprintf(`{"error":"bad_request","detail":"message type %s not allowed for relay"}`, msgAny.TypeUrl), http.StatusBadRequest)
			return false
		}
	}

	return true
}

func broadcastAndRespond(w http.ResponseWriter, r *http.Request, txBytes []byte, orgID string) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	txHash, broadcastErr := chainClient.BroadcastTxSync(ctx, txBytes)
	if broadcastErr != nil {
		logger.Error("broadcast tx failed", "err", broadcastErr, "org_id", orgID)
		http.Error(w, fmt.Sprintf(`{"error":"chain_broadcast_failed","detail":"%s"}`, broadcastErr.Error()), http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(BroadcastTxResponse{
		TxHash: txHash,
		Code:   0,
		RawLog: "",
		Height: 0,
	})
}

func decodeTx(c *chain.GrpcClient, txBytes []byte) (types.Tx, error) {
	decoder := c.GetTxConfig().TxDecoder()
	return decoder(txBytes)
}