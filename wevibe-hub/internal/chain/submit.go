package chain

import (
	"context"
	"encoding/hex"
	"fmt"
	"log/slog"
	"time"

	"github.com/cosmos/cosmos-sdk/types"
	"github.com/jackc/pgx/v5/pgxpool"
	servetypes "github.com/wevibe-network/wevibe-chain/x/serve/types"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/wlog"
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
	// MatchedKeywords is optional descriptive metadata from retrieval. It is not
	// sent to chain; x/serve v2 records serves without keyword payloads.
	MatchedKeywords []string
}

type OutcomeEventInput struct {
	EpochID           uint64
	MemoryContentHash string
	SignerPubkey      string
	Nonce             string
	Signature         string
	EpisodeRef        string
	// ServeRef is the hex serve fingerprint for the served-pairing reference.
	ServeRef string
	// Resolution is the E3 tri-state token: worked, didnt_work, or unobserved.
	Resolution string
	// Source is the E3 provenance token: harvested or user.
	Source      string
	EvidenceRef string
	Fingerprint string
}

// OutcomeResolutionFromString maps the wire token to the chain enum.
func OutcomeResolutionFromString(token string) (servetypes.OutcomeResolution, error) {
	switch token {
	case "worked":
		return servetypes.OutcomeResolution_OUTCOME_RESOLUTION_WORKED, nil
	case "didnt_work":
		return servetypes.OutcomeResolution_OUTCOME_RESOLUTION_DIDNT_WORK, nil
	case "unobserved":
		return servetypes.OutcomeResolution_OUTCOME_RESOLUTION_UNOBSERVED, nil
	default:
		return servetypes.OutcomeResolution_OUTCOME_RESOLUTION_UNSPECIFIED, fmt.Errorf("resolution must be one of worked, didnt_work, unobserved")
	}
}

// OutcomeSourceFromString maps the wire token to the chain enum.
func OutcomeSourceFromString(token string) (servetypes.OutcomeSource, error) {
	switch token {
	case "harvested":
		return servetypes.OutcomeSource_OUTCOME_SOURCE_HARVESTED, nil
	case "user":
		return servetypes.OutcomeSource_OUTCOME_SOURCE_USER, nil
	default:
		return servetypes.OutcomeSource_OUTCOME_SOURCE_UNSPECIFIED, fmt.Errorf("source must be one of harvested, user")
	}
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
		serves[i] = &servetypes.ServeEntry{
			MemoryContentHash: e.MemoryContentHash,
			ServeKeyPubkey:    e.ServeKeyPubkey,
			ServeSig:          e.ServeSig,
			Nonce:             e.Nonce,
			ContributorId:     e.ContributorID,
			ContributorWallet: e.ContributorWallet,
			ModelId:           e.ModelID,
			TurnCount:         e.TurnCount,
		}
	}

	return serves, nil
}

func buildOutcomeEventEntries(orgID string, entries []OutcomeEventInput) (uint64, []*servetypes.EventEntry, error) {
	if len(entries) == 0 {
		return 0, nil, fmt.Errorf("at least one entry required")
	}

	epoch := entries[0].EpochID
	if epoch == 0 {
		return 0, nil, fmt.Errorf("entry 0: epoch_id is required")
	}
	events := make([]*servetypes.EventEntry, len(entries))
	for i, e := range entries {
		if e.EpochID != epoch {
			return 0, nil, fmt.Errorf("entry %d: mixed epoch_id in event batch", i)
		}
		memoryHash, err := decodeHexField(e.MemoryContentHash, "memory_content_hash", 32)
		if err != nil {
			return 0, nil, fmt.Errorf("entry %d: %w", i, err)
		}
		signerPubkey, err := decodeHexField(e.SignerPubkey, "signer_pubkey", 32)
		if err != nil {
			return 0, nil, fmt.Errorf("entry %d: %w", i, err)
		}
		nonce, err := decodeHexField(e.Nonce, "nonce", 0)
		if err != nil {
			return 0, nil, fmt.Errorf("entry %d: %w", i, err)
		}
		signature, err := decodeHexField(e.Signature, "signature", 64)
		if err != nil {
			return 0, nil, fmt.Errorf("entry %d: %w", i, err)
		}
		episodeRef, err := decodeHexField(e.EpisodeRef, "episode_ref", 0)
		if err != nil {
			return 0, nil, fmt.Errorf("entry %d: %w", i, err)
		}
		evidenceRef, err := decodeHexField(e.EvidenceRef, "evidence_ref", 0)
		if err != nil {
			return 0, nil, fmt.Errorf("entry %d: %w", i, err)
		}
		serveRef, err := decodeHexField(e.ServeRef, "serve_ref", 32)
		if err != nil {
			return 0, nil, fmt.Errorf("entry %d: %w", i, err)
		}

		resolution, err := OutcomeResolutionFromString(e.Resolution)
		if err != nil {
			return 0, nil, fmt.Errorf("entry %d: %w", i, err)
		}
		source, err := OutcomeSourceFromString(e.Source)
		if err != nil {
			return 0, nil, fmt.Errorf("entry %d: %w", i, err)
		}

		event := &servetypes.EventEntry{
			EventType:         servetypes.EventType_EVENT_TYPE_OUTCOME,
			MemoryContentHash: memoryHash,
			SignerPubkey:      signerPubkey,
			Nonce:             nonce,
			Signature:         signature,
			Body: &servetypes.EventEntry_Outcome{Outcome: &servetypes.OutcomeEventBody{
				EpisodeRef:  episodeRef,
				ServeRef:    serveRef,
				Resolution:  resolution,
				Source:      source,
				EvidenceRef: evidenceRef,
			}},
		}

		if e.Fingerprint != "" {
			canonical, err := servetypes.CanonicalEventBody(event.EventType, orgID, memoryHash, epoch, signerPubkey, nonce, event)
			if err != nil {
				return 0, nil, fmt.Errorf("entry %d: canonical event body: %w", i, err)
			}
			computed := hex.EncodeToString(servetypes.ComputeEventFingerprint(canonical))
			if computed != e.Fingerprint {
				return 0, nil, fmt.Errorf("entry %d: fingerprint mismatch", i)
			}
		}

		events[i] = event
	}

	return epoch, events, nil
}

func decodeHexField(value, field string, exactLen int) ([]byte, error) {
	decoded, err := hex.DecodeString(value)
	if err != nil {
		return nil, fmt.Errorf("%s must be hex: %w", field, err)
	}
	if exactLen > 0 && len(decoded) != exactLen {
		return nil, fmt.Errorf("%s must be %d bytes, got %d", field, exactLen, len(decoded))
	}
	if exactLen == 0 && len(decoded) == 0 {
		return nil, fmt.Errorf("%s cannot be empty", field)
	}
	return decoded, nil
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

func (c *GrpcClient) BuildEventBatchMsg(orgID string, entries []OutcomeEventInput) (*servetypes.MsgSubmitEventBatch, error) {
	start := time.Now()
	epoch, events, err := buildOutcomeEventEntries(orgID, entries)
	if err != nil {
		wlog.Op(context.Background(), "chain.event_batch_relay", slog.LevelError,
			slog.String("org", orgID),
			slog.Uint64("epoch", epoch),
			slog.Int("count", len(entries)),
			slog.String("status", "err"),
			slog.String("err", err.Error()),
			slog.Int64("dur_ms", time.Since(start).Milliseconds()))
		return nil, err
	}
	wlog.Op(context.Background(), "chain.event_batch_relay", slog.LevelInfo,
		slog.String("org", orgID),
		slog.Uint64("epoch", epoch),
		slog.Int("count", len(events)),
		slog.String("status", "ok"),
		slog.Int64("dur_ms", time.Since(start).Milliseconds()))
	return &servetypes.MsgSubmitEventBatch{
		Signer: "",
		OrgId:  orgID,
		Epoch:  epoch,
		Events: events,
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
