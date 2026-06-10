package chain

import (
	"context"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/cosmos/cosmos-sdk/types"
	"github.com/jackc/pgx/v5/pgxpool"
	memorytypes "github.com/wevibe-network/wevibe-chain/x/memory/types"
	servetypes "github.com/wevibe-network/wevibe-chain/x/serve/types"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
)

type BatchMemory struct {
	ContentHash         []byte
	PlaintextHash       []byte
	Salt                []byte
	CiphertextHash      []byte
	ContributorSig      []byte
	ContributorPubkey   string
	Approvers           []string
	CommittingLeader    string
	Keywords            []*memorytypes.KeywordWeight
	ContributorID       string
	ContributorWallet   string
	EncryptedBlob       []byte
	WrappedDekEnc       []byte
	SubmittedMemoryType string
	ApprovedMemoryType  string
}

func mapMemoryTypeToChainEnum(memoryType string) (memorytypes.MemoryType, error) {
	switch memoryType {
	case protocol.MemoryTypeMemory:
		return memorytypes.MemoryType_MEMORY_TYPE_MEMORY, nil
	default:
		return memorytypes.MemoryType_MEMORY_TYPE_UNSPECIFIED, fmt.Errorf("invalid memory_type: %s", memoryType)
	}
}

func (c *GrpcClient) SubmitMemoryBatchAtomic(ctx context.Context, db *pgxpool.Pool, faucetURL, orgID string, memories []BatchMemory) (string, []string, error) {
	if len(memories) == 0 {
		return "", nil, nil
	}

	var allMsgs []types.Msg
	submissionHashes := make([]string, 0, len(memories))

	for _, mem := range memories {
		if len(mem.ContentHash) != 32 {
			return "", nil, fmt.Errorf("content_hash must be 32 bytes, got %d", len(mem.ContentHash))
		}
		if len(mem.EncryptedBlob) == 0 {
			return "", nil, fmt.Errorf("encrypted_blob cannot be empty")
		}
		if strings.TrimSpace(mem.ContributorWallet) == "" {
			return "", nil, fmt.Errorf("contributor_wallet cannot be empty")
		}
		if !protocol.IsValidMemoryType(mem.SubmittedMemoryType) {
			return "", nil, fmt.Errorf("invalid submitted memory_type: %s", mem.SubmittedMemoryType)
		}
		if !protocol.IsValidMemoryType(mem.ApprovedMemoryType) {
			return "", nil, fmt.Errorf("invalid approved memory_type: %s", mem.ApprovedMemoryType)
		}

		submittedMemoryType, err := mapMemoryTypeToChainEnum(mem.SubmittedMemoryType)
		if err != nil {
			return "", nil, err
		}
		approvedMemoryType, err := mapMemoryTypeToChainEnum(mem.ApprovedMemoryType)
		if err != nil {
			return "", nil, err
		}

		msgCommit := buildSubmitCommitmentMsg("", orgID, mem, submittedMemoryType)

		msgApprove := &memorytypes.MsgApproveMemory{
			Signer:           "",
			OrgId:            orgID,
			ContentHash:      mem.ContentHash,
			EncryptedBlob:    mem.EncryptedBlob,
			CommittingLeader: mem.CommittingLeader,
			WrappedDekEnc:    mem.WrappedDekEnc,
			PlaintextHash:    mem.PlaintextHash,
			Salt:             mem.Salt,
			CiphertextHash:   mem.CiphertextHash,
			ContributorSig:   mem.ContributorSig,
			MemoryType:       approvedMemoryType,
		}

		allMsgs = append(allMsgs, msgCommit, msgApprove)
		submissionHashes = append(submissionHashes, hex.EncodeToString(mem.ContentHash))
	}

	txResponse, err := c.BroadcastMsgsForOrgServing(ctx, db, faucetURL, orgID, allMsgs...)
	if err != nil {
		return "", nil, fmt.Errorf("broadcast: %w", err)
	}
	if txResponse == nil {
		return "", nil, fmt.Errorf("broadcast: missing tx response")
	}

	return txResponse.TxHash, submissionHashes, nil
}

func buildSubmitCommitmentMsg(signer, orgID string, mem BatchMemory, submittedMemoryType memorytypes.MemoryType) *memorytypes.MsgSubmitCommitment {
	return &memorytypes.MsgSubmitCommitment{
		Signer:            signer,
		OrgId:             orgID,
		ContentHash:       mem.ContentHash,
		Keywords:          mem.Keywords,
		ContributorId:     mem.ContributorID,
		ContributorWallet: mem.ContributorWallet,
		MemoryType:        submittedMemoryType,
	}
}

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
