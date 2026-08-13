package receipts

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
)

func CreateReceipt(
	ctx context.Context,
	pool *pgxpool.Pool,
	nodePrivkeyHex string,
	orgID string,
	billingEpoch int,
	accessEpochs []int32,
	agentPubkey string,
	queryPayload map[string]any,
	resultCIDs []string,
	agentSigHex string,
) (*protocol.UsageReceipt, error) {
	queryJSON, _ := json.Marshal(queryPayload)
	qHash := sha256.Sum256(queryJSON)
	queryCommitment := hex.EncodeToString(qHash[:])

	resultJSON, _ := json.Marshal(resultCIDs)
	rHash := sha256.Sum256(resultJSON)
	resultCommitment := hex.EncodeToString(rHash[:])

	sigMessage := queryCommitment + resultCommitment
	nodeSig, err := signReceipt(nodePrivkeyHex, sigMessage)
	if err != nil {
		return nil, fmt.Errorf("sign receipt: %w", err)
	}

	var receipt protocol.UsageReceipt
	err = pool.QueryRow(ctx, `
		INSERT INTO usage_receipts
			(org_id, billing_epoch, access_epochs, agent_pubkey,
			 query_commitment, result_commitment, agent_signature, node_signature)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING receipt_id
	`,
		orgID, billingEpoch, accessEpochs, agentPubkey,
		queryCommitment, resultCommitment, agentSigHex, nodeSig,
	).Scan(&receipt.ReceiptID)
	if err != nil {
		return nil, err
	}

	receipt.OrgID = orgID
	receipt.BillingEpoch = billingEpoch
	receipt.AccessEpochs = accessEpochs
	receipt.AgentPubkey = agentPubkey
	receipt.QueryCommitment = queryCommitment
	receipt.ResultCommitment = resultCommitment
	receipt.AgentSignature = agentSigHex
	receipt.NodeSignature = nodeSig

	return &receipt, nil
}

func signReceipt(nodePrivkeyHex, message string) (string, error) {
	if nodePrivkeyHex == "" {
		nodePrivkeyHex = strings.Repeat("00", 32)
	}
	privBytes, err := hex.DecodeString(nodePrivkeyHex)
	if err != nil {
		return "", fmt.Errorf("invalid node privkey hex: %w", err)
	}
	var privKey ed25519.PrivateKey
	if len(privBytes) == 32 {
		privKey = ed25519.NewKeyFromSeed(privBytes)
	} else if len(privBytes) == 64 {
		privKey = ed25519.PrivateKey(privBytes)
	} else {
		return "", fmt.Errorf("privkey must be 32 or 64 bytes")
	}
	sig := ed25519.Sign(privKey, []byte(message))
	return hex.EncodeToString(sig), nil
}
