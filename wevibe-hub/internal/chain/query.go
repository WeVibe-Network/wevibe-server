package chain

import (
	"context"
	"fmt"
	"time"

	attesttypes "github.com/wevibe-network/wevibe-chain/x/attestation/types"
	bwtypes "github.com/wevibe-network/wevibe-chain/x/bandwidth/types"
	emissionstypes "github.com/wevibe-network/wevibe-chain/x/emissions/types"
	memorytypes "github.com/wevibe-network/wevibe-chain/x/memory/types"
	orgtypes "github.com/wevibe-network/wevibe-chain/x/org/types"
	reptypes "github.com/wevibe-network/wevibe-chain/x/reputation/types"
	servetypes "github.com/wevibe-network/wevibe-chain/x/serve/types"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

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
		ServeAttestationRequired: resp.ServeAttestationRequired,
		ContestStakeVibe:         resp.ContestStakeVibe,
		MinContributionsPerEpoch: resp.MinContributionsPerEpoch,
	}, nil
}

// GetRepTiersFromChain queries chain org reputation tiers.
// Returns nil, nil if no tiers are configured or org does not exist.
func (c *GrpcClient) GetRepTiersFromChain(ctx context.Context, orgID string) ([]*orgtypes.RepTier, error) {
	if c == nil {
		return nil, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := c.orgQuery.GetRepTiers(ctx, &orgtypes.QueryGetRepTiersRequest{OrgId: orgID})
	if err != nil {
		if c.isNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	if resp == nil {
		return nil, nil
	}

	return resp.Tiers, nil
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
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := c.memoryQuery.GetMemoriesBatch(ctx, &memorytypes.QueryGetMemoriesBatchRequest{
		OrgId:         orgID,
		ContentHashes: contentHashes,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("chain batch query: %w", err)
	}

	results := make([]MemoryBatchResult, 0, len(resp.Memories))
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

	return results, resp.NotFound, nil
}

func mapChainMemoryTypeToString(memoryType memorytypes.MemoryType) string {
	switch memoryType {
	case memorytypes.MemoryType_MEMORY_TYPE_MEMORY:
		return protocol.MemoryTypeMemory
	default:
		return ""
	}
}
