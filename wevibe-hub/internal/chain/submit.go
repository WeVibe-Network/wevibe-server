package chain

import (
	"context"
	"encoding/hex"
	"fmt"

	"github.com/cosmos/cosmos-sdk/types"
	memorytypes "github.com/wevibe-network/wevibe-chain/x/memory/types"
	orgtypes "github.com/wevibe-network/wevibe-chain/x/org/types"
	reputationtypes "github.com/wevibe-network/wevibe-chain/x/reputation/types"
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

func (c *GrpcClient) SubmitMemoryToChain(ctx context.Context, orgID string, mem BatchMemory) (string, error) {
	if len(mem.ContentHash) != 32 {
		return "", fmt.Errorf("content_hash must be 32 bytes, got %d", len(mem.ContentHash))
	}
	if len(mem.EncryptedBlob) == 0 {
		return "", fmt.Errorf("encrypted_blob cannot be empty")
	}
	if !protocol.IsValidMemoryType(mem.SubmittedMemoryType) {
		return "", fmt.Errorf("invalid submitted memory_type: %s", mem.SubmittedMemoryType)
	}
	if !protocol.IsValidMemoryType(mem.ApprovedMemoryType) {
		return "", fmt.Errorf("invalid approved memory_type: %s", mem.ApprovedMemoryType)
	}

	submittedMemoryType, err := mapMemoryTypeToChainEnum(mem.SubmittedMemoryType)
	if err != nil {
		return "", err
	}
	approvedMemoryType, err := mapMemoryTypeToChainEnum(mem.ApprovedMemoryType)
	if err != nil {
		return "", err
	}

	msgCommit := &memorytypes.MsgSubmitCommitment{
		Signer:            c.submitter.String(),
		OrgId:             orgID,
		ContentHash:       mem.ContentHash,
		Keywords:          mem.Keywords,
		ContributorId:     mem.ContributorID,
		ContributorWallet: mem.ContributorWallet,
		MemoryType:        submittedMemoryType,
	}

	msgApprove := &memorytypes.MsgApproveMemory{
		Signer:           c.submitter.String(),
		OrgId:            orgID,
		ContentHash:      mem.ContentHash,
		EncryptedBlob:    mem.EncryptedBlob,
		Approvers:        mem.Approvers,
		CommittingLeader: mem.CommittingLeader,
		WrappedDekEnc:    mem.WrappedDekEnc,
		PlaintextHash:    mem.PlaintextHash,
		Salt:             mem.Salt,
		CiphertextHash:   mem.CiphertextHash,
		ContributorSig:   mem.ContributorSig,
		MemoryType:       approvedMemoryType,
	}

	txHash, err := c.BroadcastMsgs(ctx, msgCommit, msgApprove)
	if err != nil {
		return "", fmt.Errorf("broadcast: %w", err)
	}

	return txHash, nil
}

func mapMemoryTypeToChainEnum(memoryType string) (memorytypes.MemoryType, error) {
	switch memoryType {
	case protocol.MemoryTypeCorrectImplementation:
		return memorytypes.MemoryType_MEMORY_TYPE_CORRECT_IMPLEMENTATION, nil
	case protocol.MemoryTypeNegativeSignal:
		return memorytypes.MemoryType_MEMORY_TYPE_NEGATIVE_SIGNAL, nil
	default:
		return memorytypes.MemoryType_MEMORY_TYPE_UNSPECIFIED, fmt.Errorf("invalid memory_type: %s", memoryType)
	}
}

func (c *GrpcClient) UpdateOrgChainConfig(
	ctx context.Context,
	orgID string,
	serveAttestationRequired bool,
	minContributionsPerEpoch uint64,
	contestStakeVibe uint64,
	repTiers []*orgtypes.RepTier,
) (string, error) {
	if len(repTiers) == 0 {
		return "", fmt.Errorf("rep_tiers cannot be empty")
	}

	msgConfig := &orgtypes.MsgSetOrgConfig{
		Signer:                   c.submitter.String(),
		OrgId:                    orgID,
		ServeAttestationRequired: serveAttestationRequired,
		MinContributionsPerEpoch: minContributionsPerEpoch,
		ContestStakeVibe:         contestStakeVibe,
	}

	msgRepTiers := &orgtypes.MsgSetRepTiers{
		Signer: c.submitter.String(),
		OrgId:  orgID,
		Tiers:  repTiers,
	}

	txHash, err := c.BroadcastMsgs(ctx, msgConfig, msgRepTiers)
	if err != nil {
		return "", fmt.Errorf("broadcast: %w", err)
	}

	return txHash, nil
}

func (c *GrpcClient) SubmitMemoryBatch(ctx context.Context, orgID string, memories []BatchMemory) ([]string, error) {
	var txHashes []string
	for _, mem := range memories {
		txHash, err := c.SubmitMemoryToChain(ctx, orgID, mem)
		if err != nil {
			return txHashes, fmt.Errorf("batch submit failed at tx %d: %w", len(txHashes), err)
		}
		txHashes = append(txHashes, txHash)
	}
	return txHashes, nil
}

func (c *GrpcClient) SubmitMemoryBatchAtomic(ctx context.Context, orgID string, memories []BatchMemory) (string, []string, error) {
	if len(memories) == 0 {
		return "", nil, nil
	}
	if len(memories) == 1 {
		txHash, err := c.SubmitMemoryToChain(ctx, orgID, memories[0])
		return txHash, []string{txHash}, err
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

		msgCommit := &memorytypes.MsgSubmitCommitment{
			Signer:            c.submitter.String(),
			OrgId:             orgID,
			ContentHash:       mem.ContentHash,
			Keywords:          mem.Keywords,
			ContributorId:     mem.ContributorID,
			ContributorWallet: mem.ContributorWallet,
			MemoryType:        submittedMemoryType,
		}

		msgApprove := &memorytypes.MsgApproveMemory{
			Signer:           c.submitter.String(),
			OrgId:            orgID,
			ContentHash:      mem.ContentHash,
			EncryptedBlob:    mem.EncryptedBlob,
			Approvers:        mem.Approvers,
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

	txHash, err := c.BroadcastMsgs(ctx, allMsgs...)
	if err != nil {
		return "", nil, fmt.Errorf("broadcast: %w", err)
	}

	return txHash, submissionHashes, nil
}

type ServeEntryInput struct {
	MemoryContentHash []byte
	ServeKey          string
	ContributorID     string
	ContributorWallet string
	Nullifier         []byte
	ModelID           string
	TurnCount         uint32
}

type DenialEntryInput struct {
	MemoryHash []byte
	Nullifier  []byte
	DenyKey    string
	Reason     string
}

func (c *GrpcClient) SubmitServeBatch(ctx context.Context, orgID string, epoch uint64, entries []ServeEntryInput) (string, error) {
	if len(entries) == 0 {
		return "", fmt.Errorf("at least one entry required")
	}
	for i, e := range entries {
		if len(e.MemoryContentHash) != 32 {
			return "", fmt.Errorf("entry %d: memory_content_hash must be 32 bytes, got %d", i, len(e.MemoryContentHash))
		}
		if len(e.Nullifier) != 32 {
			return "", fmt.Errorf("entry %d: nullifier must be 32 bytes, got %d", i, len(e.Nullifier))
		}
	}

	serves := make([]*servetypes.ServeEntry, len(entries))
	for i, e := range entries {
		serves[i] = &servetypes.ServeEntry{
			MemoryContentHash: e.MemoryContentHash,
			ServeKey:          e.ServeKey,
			ContributorId:     e.ContributorID,
			ContributorWallet: e.ContributorWallet,
			Nullifier:         e.Nullifier,
			ModelId:           e.ModelID,
			TurnCount:         e.TurnCount,
		}
	}

	msg := &servetypes.MsgSubmitServeBatch{
		Signer: c.submitter.String(),
		OrgId:  orgID,
		Epoch:  epoch,
		Serves: serves,
	}

	var allMsgs []types.Msg
	allMsgs = append(allMsgs, msg)
	for _, e := range entries {
		contributorID := e.ContributorWallet
		if contributorID == "" {
			contributorID = e.ContributorID
		}
		allMsgs = append(allMsgs, &reputationtypes.MsgIncrementServe{
			Authority:     c.submitter.String(),
			ContributorId: contributorID,
			OrgId:         orgID,
			MemoryCid:     hex.EncodeToString(e.MemoryContentHash),
			ServeCount:    uint64(e.TurnCount),
		})
	}

	txHash, err := c.BroadcastMsgs(ctx, allMsgs...)
	if err != nil {
		return "", fmt.Errorf("broadcast: %w", err)
	}

	return txHash, nil
}

func (c *GrpcClient) SubmitDenialBatch(ctx context.Context, orgID string, epoch uint64, entries []DenialEntryInput) (string, error) {
	if len(entries) == 0 {
		return "", fmt.Errorf("at least one entry required")
	}

	denials := make([]*servetypes.DenialEntry, len(entries))
	for i, e := range entries {
		if len(e.MemoryHash) != 32 {
			return "", fmt.Errorf("entry %d: memory_hash must be 32 bytes, got %d", i, len(e.MemoryHash))
		}
		if len(e.Nullifier) != 32 {
			return "", fmt.Errorf("entry %d: nullifier must be 32 bytes, got %d", i, len(e.Nullifier))
		}
		if e.DenyKey == "" {
			return "", fmt.Errorf("entry %d: deny_key is required", i)
		}
		if e.Reason == "" {
			return "", fmt.Errorf("entry %d: reason is required", i)
		}

		denials[i] = &servetypes.DenialEntry{
			MemoryHash: e.MemoryHash,
			Nullifier:  e.Nullifier,
			DenyKey:    e.DenyKey,
			Reason:     e.Reason,
		}
	}

	msg := &servetypes.MsgSubmitDenialBatch{
		Signer:  c.submitter.String(),
		OrgId:   orgID,
		Epoch:   epoch,
		Entries: denials,
	}

	txHash, err := c.BroadcastMsgs(ctx, msg)
	if err != nil {
		return "", fmt.Errorf("broadcast: %w", err)
	}

	return txHash, nil
}

type ReportMemoryInput struct {
	ContentHash    []byte
	ReporterID     string
	ReporterWallet string
	Reason         string
	Epoch          uint64
}

func (c *GrpcClient) SubmitMemoryReport(ctx context.Context, orgID string, input ReportMemoryInput, contributorWalletAddress string) (string, error) {
	if len(input.ContentHash) != 32 {
		return "", fmt.Errorf("content_hash must be 32 bytes, got %d", len(input.ContentHash))
	}
	if input.ReporterID == "" {
		return "", fmt.Errorf("reporter_id cannot be empty")
	}
	if input.Reason == "" {
		return "", fmt.Errorf("reason cannot be empty")
	}

	msg := &memorytypes.MsgReportMemory{
		Signer:            c.submitter.String(),
		OrgId:             orgID,
		ContentHash:       input.ContentHash,
		ContributorPubkey: input.ReporterID,
		ReporterPubkey:    input.ReporterID,
		Reason:            input.Reason,
	}

	contributorID := contributorWalletAddress

	var allMsgs []types.Msg
	allMsgs = append(allMsgs, msg)
	if contributorID != "" {
		allMsgs = append(allMsgs, &reputationtypes.MsgRecordBan{
			Authority:     c.submitter.String(),
			ContributorId: contributorID,
			OrgId:         orgID,
			MemoryCid:     hex.EncodeToString(input.ContentHash),
		})
	}

	txHash, err := c.BroadcastMsgs(ctx, allMsgs...)
	if err != nil {
		return "", fmt.Errorf("broadcast report: %w", err)
	}

	return txHash, nil
}

func (c *GrpcClient) RegisterOrgOnChain(ctx context.Context, orgID, leader, domain string, storageQuota, retrievalBudget uint64) (string, error) {
	msg := &orgtypes.MsgRegisterOrg{
		Signer:          c.submitter.String(),
		OrgId:           orgID,
		Leader:          leader,
		StorageQuota:    storageQuota,
		RetrievalBudget: retrievalBudget,
		Domain:          domain,
	}

	txHash, err := c.BroadcastMsgs(ctx, msg)
	if err != nil {
		return "", fmt.Errorf("broadcast register org: %w", err)
	}

	return txHash, nil
}
