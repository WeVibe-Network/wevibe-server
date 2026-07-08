package chain

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	attesttypes "github.com/wevibe-network/wevibe-chain/x/attestation/types"
	bwtypes "github.com/wevibe-network/wevibe-chain/x/bandwidth/types"
	emissionstypes "github.com/wevibe-network/wevibe-chain/x/emissions/types"
	memorytypes "github.com/wevibe-network/wevibe-chain/x/memory/types"
	orgtypes "github.com/wevibe-network/wevibe-chain/x/org/types"
	reptypes "github.com/wevibe-network/wevibe-chain/x/reputation/types"
	servetypes "github.com/wevibe-network/wevibe-chain/x/serve/types"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/wlog"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// maxContentHashesPerBatch mirrors the chain-side cap enforced in
// wevibe-chain/x/memory/keeper/grpc_query.go ("max 50 content hashes per batch").
// The hub MUST chunk requests to <= this many hashes per gRPC call.
const maxContentHashesPerBatch = 50

// --- x/org ---

// IsOrgRegistered checks whether an org exists on chain.
func (c *GrpcClient) IsOrgRegistered(ctx context.Context, orgID string) (bool, error) {
	if c == nil {
		return false, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := c.orgQuery.GetOrg(ctx, &orgtypes.QueryGetOrgRequest{
		OrgId: orgID,
	})
	if err != nil {
		if c.isNotFound(err) {
			return false, nil
		}
		return false, err
	}
	return resp.OrgId != "", nil
}

// GetOrgFromChain queries the chain for org details.
// Returns nil, nil if org not found.
func (c *GrpcClient) GetOrgFromChain(ctx context.Context, orgID string) (*orgtypes.StoredOrg, error) {
	if c == nil {
		return nil, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := c.orgQuery.GetOrg(ctx, &orgtypes.QueryGetOrgRequest{
		OrgId: orgID,
	})
	if err != nil {
		if c.isNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return &orgtypes.StoredOrg{
		OrgId:           resp.OrgId,
		Leader:          resp.Leader,
		CreatedAt:       resp.CreatedAt,
		RenewalHeight:   resp.RenewalHeight,
		StorageQuota:    resp.StorageQuota,
		RetrievalBudget: resp.RetrievalBudget,
		Status:          resp.Status,
		Domain:          resp.Domain,
	}, nil
}

// GetOrgMembersFromChain queries the chain for org members.
// Returns nil, nil if org not found.
func (c *GrpcClient) GetOrgMembersFromChain(ctx context.Context, orgID string) ([]orgtypes.MemberInfo, error) {
	if c == nil {
		return nil, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := c.orgQuery.GetMembers(ctx, &orgtypes.QueryGetMembersRequest{
		OrgId: orgID,
	})
	if err != nil {
		if c.isNotFound(err) {
			return nil, nil
		}
		return nil, err
	}

	members := make([]orgtypes.MemberInfo, 0, len(resp.Members))
	for _, member := range resp.Members {
		if member == nil {
			continue
		}
		members = append(members, *member)
	}

	return members, nil
}

// GetOrgConfigFromChain queries chain org configuration.
// Returns nil, nil if org config is not found.
func (c *GrpcClient) GetOrgConfigFromChain(ctx context.Context, orgID string) (*orgtypes.StoredOrgConfig, error) {
	if c == nil {
		return nil, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := c.orgQuery.GetOrgConfig(ctx, &orgtypes.QueryGetOrgConfigRequest{OrgId: orgID})
	if err != nil {
		if c.isNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	if resp == nil {
		return nil, nil
	}

	return &orgtypes.StoredOrgConfig{
		OrgId:                    orgID,
		ServeReceiptRequired:     resp.ServeReceiptRequired,
		ContestStakeVibe:         resp.ContestStakeVibe,
		MinContributionsPerEpoch: resp.MinContributionsPerEpoch,
	}, nil
}

// GetOrgAccountFromChain queries the chain org account for feegrant usage.
func (c *GrpcClient) GetOrgAccountFromChain(ctx context.Context, orgID string) (string, error) {
	if c == nil {
		return "", nil
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := c.orgQuery.GetOrgAccount(ctx, &orgtypes.QueryGetOrgAccountRequest{OrgId: orgID})
	if err != nil {
		if c.isNotFound(err) {
			return "", nil
		}
		return "", err
	}
	if resp == nil {
		return "", nil
	}

	return resp.AccountAddress, nil
}

// GetOrgTreasuryBalanceFromChain queries the org account uvibe balance.
func (c *GrpcClient) GetOrgTreasuryBalanceFromChain(ctx context.Context, orgID string) (uint64, error) {
	if c == nil {
		return 0, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := c.orgQuery.GetOrgAccount(ctx, &orgtypes.QueryGetOrgAccountRequest{OrgId: orgID})
	if err != nil {
		if c.isNotFound(err) {
			return 0, nil
		}
		return 0, err
	}
	if resp == nil || resp.Balance == "" {
		return 0, nil
	}

	balance, err := strconv.ParseUint(resp.Balance, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parse org treasury balance: %w", err)
	}

	return balance, nil
}

// --- x/memory ---

// GetEpochMerkleRoot queries the chain for a submitted merkle root.
func (c *GrpcClient) GetEpochMerkleRoot(ctx context.Context, orgID string, epoch uint64) (*memorytypes.QueryGetEpochMerkleRootResponse, error) {
	if c == nil {
		return nil, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := c.memoryQuery.GetEpochMerkleRoot(ctx, &memorytypes.QueryGetEpochMerkleRootRequest{
		OrgId: orgID,
		Epoch: epoch,
	})
	if err != nil {
		if c.isNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return resp, nil
}

// --- x/serve ---

// GetServeParams queries the serve module parameters.
func (c *GrpcClient) GetServeParams(ctx context.Context) (*servetypes.QueryParamsResponse, error) {
	if c == nil {
		return nil, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := c.serveQuery.Params(ctx, &servetypes.QueryParamsRequest{})
	if err != nil {
		return nil, err
	}
	return resp, nil
}

// GetEpochServeStats queries serve statistics for an org+epoch.
func (c *GrpcClient) GetEpochServeStats(ctx context.Context, orgID string, epoch uint64) (*servetypes.QueryGetEpochServeStatsResponse, error) {
	if c == nil {
		return nil, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := c.serveQuery.GetEpochServeStats(ctx, &servetypes.QueryGetEpochServeStatsRequest{
		OrgId: orgID,
		Epoch: epoch,
	})
	if err != nil {
		if c.isNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return resp, nil
}

// --- x/attestation ---

// GetAttestationParams queries the attestation module parameters.
func (c *GrpcClient) GetAttestationParams(ctx context.Context) (*attesttypes.QueryParamsResponse, error) {
	if c == nil {
		return nil, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := c.attestQuery.Params(ctx, &attesttypes.QueryParamsRequest{})
	if err != nil {
		return nil, err
	}
	return resp, nil
}

// GetSessionAttestation queries a specific session attestation.
func (c *GrpcClient) GetSessionAttestation(ctx context.Context, orgID string, sessionHash []byte) (*attesttypes.QueryGetSessionAttestationResponse, error) {
	if c == nil {
		return nil, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := c.attestQuery.GetSessionAttestation(ctx, &attesttypes.QueryGetSessionAttestationRequest{
		OrgId:       orgID,
		SessionHash: sessionHash,
	})
	if err != nil {
		if c.isNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return resp, nil
}

// --- x/bandwidth ---

// GetBandwidth queries bandwidth state for an org+epoch.
func (c *GrpcClient) GetBandwidth(ctx context.Context, orgID string, epoch uint64) (*bwtypes.QueryGetBandwidthStateResponse, error) {
	if c == nil {
		return nil, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := c.bandwidthQuery.GetBandwidthState(ctx, &bwtypes.QueryGetBandwidthStateRequest{
		OrgId: orgID,
		Epoch: epoch,
	})
	if err != nil {
		if c.isNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return resp, nil
}

// --- x/emissions ---

// GetEmissionsParams queries the emissions module parameters.
func (c *GrpcClient) GetEmissionsParams(ctx context.Context) (*emissionstypes.QueryParamsResponse, error) {
	if c == nil {
		return nil, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := c.emissionsQuery.Params(ctx, &emissionstypes.QueryParamsRequest{})
	if err != nil {
		return nil, err
	}
	return resp, nil
}

// --- x/reputation ---

// GetReputationStats queries reputation for a contributor.
func (c *GrpcClient) GetReputationStats(ctx context.Context, developerID string) (*reptypes.QueryGetReputationResponse, error) {
	if c == nil {
		return nil, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := c.repQuery.GetReputation(ctx, &reptypes.QueryGetReputationRequest{
		Developer: []byte(developerID),
	})
	if err != nil {
		if c.isNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return resp, nil
}

// GetContributorProfile queries the chain for a contributor's on-chain reputation profile.
// Returns nil if chain is unreachable or contributor not found (nil-safe).
func (c *GrpcClient) GetContributorProfile(ctx context.Context, contributorID string, epoch uint64) (*reptypes.StoredContributorProfile, error) {
	if c == nil || c.conn == nil {
		return nil, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := c.repQuery.GetContributorProfile(ctx, &reptypes.QueryGetContributorProfileRequest{
		ContributorId: contributorID,
		Epoch:         epoch,
	})
	if err != nil {
		if c.isNotFound(err) {
			return nil, nil
		}
		return nil, nil
	}
	if resp == nil {
		return nil, nil
	}
	return &reptypes.StoredContributorProfile{
		ContributorId:         resp.ContributorId,
		TotalApprovedMemories: resp.MemoryCount,
	}, nil
}

func (c *GrpcClient) isNotFound(err error) bool {
	if err == nil {
		return false
	}
	s, ok := status.FromError(err)
	if !ok {
		return false
	}
	return s.Code() == codes.NotFound
}

type MemoryBatchResult struct {
	ContentHash       []byte
	EncryptedBlob     []byte
	WrappedDekEnc     []byte
	Capsule           []byte
	Keywords          []*memorytypes.KeywordWeight
	ContributorPubkey string
	Epoch             uint64
	State             int32
	MemoryType        string
	ServeCountTotal   uint64
	DenialCountTotal  uint64
	LastActiveEpoch   uint64
	ArchivedEpoch     uint64
}

func (c *GrpcClient) GetMemoriesBatch(ctx context.Context, orgID string, contentHashes [][]byte) ([]MemoryBatchResult, [][]byte, error) {
	hashCount := len(contentHashes)
	chunkCount := 0
	if hashCount > 0 {
		chunkCount = (hashCount + maxContentHashesPerBatch - 1) / maxContentHashesPerBatch
	}

	wlog.Op(ctx, "chain.GetMemoriesBatch", slog.LevelInfo,
		slog.String("org", orgID),
		slog.Int("hashCount", hashCount),
		slog.Int("chunkCount", chunkCount),
		slog.Int("maxPerChunk", maxContentHashesPerBatch))

	results := make([]MemoryBatchResult, 0, hashCount)
	var notFound [][]byte

	for chunkIndex, start := 0, 0; start < hashCount; chunkIndex, start = chunkIndex+1, start+maxContentHashesPerBatch {
		end := start + maxContentHashesPerBatch
		if end > hashCount {
			end = hashCount
		}

		chunkHashes := contentHashes[start:end]
		resp, err := func() (*memorytypes.QueryGetMemoriesBatchResponse, error) {
			chunkCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()

			return c.memoryQuery.GetMemoriesBatch(chunkCtx, &memorytypes.QueryGetMemoriesBatchRequest{
				OrgId:         orgID,
				ContentHashes: chunkHashes,
			})
		}()
		if err != nil {
			wlog.Op(ctx, "chain.GetMemoriesBatch", slog.LevelError,
				slog.String("org", orgID),
				slog.Int("chunkIndex", chunkIndex+1),
				slog.Int("chunkCount", chunkCount),
				slog.Int("chunkSize", len(chunkHashes)),
				slog.String("err", err.Error()))
			return nil, nil, fmt.Errorf("chain batch query (chunk %d/%d, %d hashes): %w", chunkIndex+1, chunkCount, len(chunkHashes), err)
		}

		for _, m := range resp.Memories {
			results = append(results, MemoryBatchResult{
				ContentHash:       m.ContentHash,
				EncryptedBlob:     m.EncryptedBlob,
				WrappedDekEnc:     m.WrappedDekEnc,
				Capsule:           nil,
				Keywords:          m.Keywords,
				ContributorPubkey: m.ContributorPubkey,
				Epoch:             m.Epoch,
				State:             int32(m.State),
				MemoryType:        mapChainMemoryTypeToString(m.MemoryType),
				ServeCountTotal:   m.ServeCountTotal,
				DenialCountTotal:  m.DenialCountTotal,
				LastActiveEpoch:   m.LastActiveEpoch,
				ArchivedEpoch:     m.ArchivedEpoch,
			})
		}

		notFound = append(notFound, resp.NotFound...)

		wlog.Op(ctx, "chain.GetMemoriesBatch.chunk", slog.LevelInfo,
			slog.String("org", orgID),
			slog.Int("chunkIndex", chunkIndex+1),
			slog.Int("chunkCount", chunkCount),
			slog.Int("chunkSize", len(chunkHashes)),
			slog.Int("returned", len(resp.Memories)),
			slog.Int("notFound", len(resp.NotFound)))
	}

	wlog.Op(ctx, "chain.GetMemoriesBatch", slog.LevelInfo,
		slog.String("org", orgID),
		slog.Int("hashCount", hashCount),
		slog.Int("chunkCount", chunkCount),
		slog.Int("resultCount", len(results)),
		slog.Int("notFoundCount", len(notFound)),
		slog.String("status", "ok"))

	return results, notFound, nil
}

func mapChainMemoryTypeToString(memoryType memorytypes.MemoryType) string {
	switch memoryType {
	case memorytypes.MemoryType_MEMORY_TYPE_MEMORY:
		return protocol.MemoryTypeMemory
	default:
		return ""
	}
}
