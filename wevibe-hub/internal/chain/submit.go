package chain

import (
	"context"
	"fmt"

	"github.com/cosmos/cosmos-sdk/types"
	"github.com/jackc/pgx/v5/pgxpool"
	servetypes "github.com/wevibe-network/wevibe-chain/x/serve/types"
)

type ServeEntryInput struct {
	MemoryContentHash []byte
	ServeKeyPubkey    []byte
	ServeSig          []byte
	Nonce             []byte
	ContributorID     string
	ContributorWallet string
	ModelID           string
	TurnCount         uint32
	// MatchedKeywords is the intersection of the served memory's keywords and
	// the query's keyword set, computed at retrieval time. Required, non-empty.
	// Per DECISIONS.md D-4.2 Implementation Clarifications (DMO-007) and
	// chain x/serve which rejects empty sets at keeper.go:458-460.
	MatchedKeywords []string
}

type DenialEntryInput struct {
	MemoryHash       []byte
	Reason           string
	ServeKeyPubkey   []byte
	ServeSig         []byte
	ServeFingerprint []byte
	Nonce            []byte
}

func buildServeEntries(entries []ServeEntryInput) ([]*servetypes.ServeEntry, error) {
	if len(entries) == 0 {
		return nil, fmt.Errorf("at least one entry required")
	}

	serves := make([]*servetypes.ServeEntry, len(entries))
	for i, e := range entries {
		if len(e.MemoryContentHash) != 32 {
			return nil, fmt.Errorf("entry %d: memory_content_hash must be 32 bytes, got %d", i, len(e.MemoryContentHash))
		}
		if len(e.ServeKeyPubkey) != 32 {
			return nil, fmt.Errorf("entry %d: serve_key_pubkey must be 32 bytes, got %d", i, len(e.ServeKeyPubkey))
		}
		if len(e.ServeSig) != 64 {
			return nil, fmt.Errorf("entry %d: serve_sig must be 64 bytes, got %d", i, len(e.ServeSig))
		}
		if len(e.Nonce) == 0 {
			return nil, fmt.Errorf("entry %d: nonce cannot be empty", i)
		}
		if len(e.MatchedKeywords) == 0 {
			return nil, fmt.Errorf("entry %d: matched_keywords cannot be empty", i)
		}

		serves[i] = &servetypes.ServeEntry{
			MemoryContentHash: e.MemoryContentHash,
			ServeKeyPubkey:    e.ServeKeyPubkey,
			ServeSig:          e.ServeSig,
			Nonce:             e.Nonce,
			ContributorId:     e.ContributorID,
			ContributorWallet: e.ContributorWallet,
			ModelId:           e.ModelID,
			TurnCount:         e.TurnCount,
			MatchedKeywords:   e.MatchedKeywords,
		}
	}

	return serves, nil
}

func buildDenialEntries(entries []DenialEntryInput) ([]*servetypes.DenialEntry, error) {
	if len(entries) == 0 {
		return nil, fmt.Errorf("at least one entry required")
	}

	denials := make([]*servetypes.DenialEntry, len(entries))
	for i, e := range entries {
		if len(e.MemoryHash) != 32 {
			return nil, fmt.Errorf("entry %d: memory_hash must be 32 bytes, got %d", i, len(e.MemoryHash))
		}
		if e.Reason == "" {
			return nil, fmt.Errorf("entry %d: reason is required", i)
		}
		if len(e.ServeKeyPubkey) != 32 {
			return nil, fmt.Errorf("entry %d: serve_key_pubkey must be 32 bytes, got %d", i, len(e.ServeKeyPubkey))
		}
		if len(e.ServeSig) != 64 {
			return nil, fmt.Errorf("entry %d: serve_sig must be 64 bytes, got %d", i, len(e.ServeSig))
		}
		if len(e.ServeFingerprint) != 32 {
			return nil, fmt.Errorf("entry %d: serve_fingerprint must be 32 bytes, got %d", i, len(e.ServeFingerprint))
		}
		if len(e.Nonce) == 0 {
			return nil, fmt.Errorf("entry %d: nonce cannot be empty", i)
		}

		denials[i] = &servetypes.DenialEntry{
			MemoryHash:       e.MemoryHash,
			Reason:           e.Reason,
			ServeKeyPubkey:   e.ServeKeyPubkey,
			ServeSig:         e.ServeSig,
			ServeFingerprint: e.ServeFingerprint,
			Nonce:            e.Nonce,
		}
	}

	return denials, nil
}

func (c *GrpcClient) BuildServeBatchMsg(orgID string, epoch uint64, entries []ServeEntryInput) (*servetypes.MsgSubmitServeBatch, error) {
	serves, err := buildServeEntries(entries)
	if err != nil {
		return nil, err
	}

	return &servetypes.MsgSubmitServeBatch{
		Signer: "",
		OrgId:  orgID,
		Epoch:  epoch,
		Serves: serves,
	}, nil
}

func (c *GrpcClient) BuildDenialBatchMsg(orgID string, epoch uint64, entries []DenialEntryInput) (*servetypes.MsgSubmitDenialBatch, error) {
	denials, err := buildDenialEntries(entries)
	if err != nil {
		return nil, err
	}

	return &servetypes.MsgSubmitDenialBatch{
		Signer:  "",
		OrgId:   orgID,
		Epoch:   epoch,
		Entries: denials,
	}, nil
}

func (c *GrpcClient) SubmitRelayBatch(ctx context.Context, db *pgxpool.Pool, faucetURL, orgID string, msgs []types.Msg) (string, error) {
	txResponse, err := c.BroadcastMsgsForOrgServingCommit(ctx, db, faucetURL, orgID, msgs...)
	if err != nil {
		return "", fmt.Errorf("broadcast: %w", err)
	}
	if txResponse == nil {
		return "", fmt.Errorf("broadcast: missing tx response")
	}

	return txResponse.TxHash, nil
}

func (c *GrpcClient) SubmitServeBatch(ctx context.Context, db *pgxpool.Pool, faucetURL, orgID string, epoch uint64, entries []ServeEntryInput) (string, error) {
	msg, err := c.BuildServeBatchMsg(orgID, epoch, entries)
	if err != nil {
		return "", err
	}

	// NOTE (CO-035): we intentionally do NOT bundle MsgIncrementServe here.
	// The chain's x/serve keeper invokes ReputationKeeper.RecordServe()
	// internally when processing MsgSubmitServeBatch (see
	// wevibe-chain/x/serve/keeper/keeper.go:276). Submitting
	// MsgIncrementServe from the hub fails authorization
	// (msg.Authority != keeper.authority — only the gov module address is
	// accepted by reputation/keeper/msg_server.go:75-77) which causes the
	// entire bundled TX to roll back atomically, leaving serve_count_total=0
	// on the chain. This was the secondary defect surfaced once the
	// hub→chain pipeline started broadcasting in CO-035.

	return c.SubmitRelayBatch(ctx, db, faucetURL, orgID, []types.Msg{msg})
}

func (c *GrpcClient) SubmitDenialBatch(ctx context.Context, db *pgxpool.Pool, faucetURL, orgID string, epoch uint64, entries []DenialEntryInput) (string, error) {
	msg, err := c.BuildDenialBatchMsg(orgID, epoch, entries)
	if err != nil {
		return "", err
	}

	return c.SubmitRelayBatch(ctx, db, faucetURL, orgID, []types.Msg{msg})
}
