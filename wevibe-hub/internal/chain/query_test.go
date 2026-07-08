package chain

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"reflect"
	"strings"
	"testing"

	memorytypes "github.com/wevibe-network/wevibe-chain/x/memory/types"
	"google.golang.org/grpc"
)

type fakeMemoryQueryClient struct {
	callSizes  []int
	failOnCall int
	callCount  int
}

func (f *fakeMemoryQueryClient) GetMemory(context.Context, *memorytypes.QueryGetMemoryRequest, ...grpc.CallOption) (*memorytypes.QueryGetMemoryResponse, error) {
	panic("not used")
}

func (f *fakeMemoryQueryClient) GetPendingCommitments(context.Context, *memorytypes.QueryGetPendingCommitmentsRequest, ...grpc.CallOption) (*memorytypes.QueryGetPendingCommitmentsResponse, error) {
	panic("not used")
}

func (f *fakeMemoryQueryClient) GetMemoryCount(context.Context, *memorytypes.QueryGetMemoryCountRequest, ...grpc.CallOption) (*memorytypes.QueryGetMemoryCountResponse, error) {
	panic("not used")
}

func (f *fakeMemoryQueryClient) GetEpochMerkleRoot(context.Context, *memorytypes.QueryGetEpochMerkleRootRequest, ...grpc.CallOption) (*memorytypes.QueryGetEpochMerkleRootResponse, error) {
	panic("not used")
}

func (f *fakeMemoryQueryClient) Params(context.Context, *memorytypes.QueryParamsRequest, ...grpc.CallOption) (*memorytypes.QueryParamsResponse, error) {
	panic("not used")
}

func (f *fakeMemoryQueryClient) ListRelationships(context.Context, *memorytypes.QueryListRelationshipsRequest, ...grpc.CallOption) (*memorytypes.QueryListRelationshipsResponse, error) {
	panic("not used")
}

func (f *fakeMemoryQueryClient) GetValidity(context.Context, *memorytypes.QueryGetValidityRequest, ...grpc.CallOption) (*memorytypes.QueryGetValidityResponse, error) {
	panic("not used")
}

func (f *fakeMemoryQueryClient) GetMemoriesBatch(_ context.Context, in *memorytypes.QueryGetMemoriesBatchRequest, _ ...grpc.CallOption) (*memorytypes.QueryGetMemoriesBatchResponse, error) {
	f.callCount++
	f.callSizes = append(f.callSizes, len(in.ContentHashes))

	if f.failOnCall > 0 && f.callCount == f.failOnCall {
		return nil, errors.New("forced batch error")
	}

	memories := make([]*memorytypes.StoredMemoryCommitment, 0, len(in.ContentHashes))
	for _, h := range in.ContentHashes {
		memories = append(memories, &memorytypes.StoredMemoryCommitment{ContentHash: append([]byte(nil), h...)})
	}

	return &memorytypes.QueryGetMemoriesBatchResponse{Memories: memories}, nil
}

func TestGetMemoriesBatch_ChunksWithinChainCap(t *testing.T) {
	tests := []struct {
		name string
		n    int
	}{
		{name: "below_cap", n: 49},
		{name: "at_cap", n: 50},
		{name: "cap_plus_one", n: 51},
		{name: "double_cap", n: 100},
		{name: "triple_cap", n: 150},
		{name: "empty", n: 0},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			hashes := buildDistinctHashes(tc.n)
			fake := &fakeMemoryQueryClient{}
			c := &GrpcClient{memoryQuery: fake}

			results, notFound, err := c.GetMemoriesBatch(context.Background(), "org-test", hashes)
			if err != nil {
				t.Fatalf("GetMemoriesBatch returned error: %v", err)
			}

			if len(results) != tc.n {
				t.Fatalf("unexpected results length: got %d want %d", len(results), tc.n)
			}

			expectedChunks := 0
			if tc.n > 0 {
				expectedChunks = (tc.n + maxContentHashesPerBatch - 1) / maxContentHashesPerBatch
			}
			if len(fake.callSizes) != expectedChunks {
				t.Fatalf("unexpected chunk call count: got %d want %d", len(fake.callSizes), expectedChunks)
			}

			for i, size := range fake.callSizes {
				if size > maxContentHashesPerBatch {
					t.Fatalf("chunk %d exceeded cap: got %d want <= %d", i+1, size, maxContentHashesPerBatch)
				}
			}

			if !reflect.DeepEqual(hashMultisetFromResults(results), hashMultisetFromHashes(hashes)) {
				t.Fatalf("returned content-hash multiset does not match input")
			}

			for i := range results {
				if !bytes.Equal(results[i].ContentHash, hashes[i]) {
					t.Fatalf("result ordering mismatch at index %d", i)
				}
			}

			if tc.n == 0 {
				if notFound != nil {
					t.Fatalf("expected nil notFound for empty input, got length %d", len(notFound))
				}
				return
			}

			if len(notFound) != 0 {
				t.Fatalf("expected empty notFound, got %d", len(notFound))
			}
		})
	}
}

func TestGetMemoriesBatch_ReturnsChunkError(t *testing.T) {
	hashes := buildDistinctHashes(maxContentHashesPerBatch*2 + 10)
	fake := &fakeMemoryQueryClient{failOnCall: 2}
	c := &GrpcClient{memoryQuery: fake}

	_, _, err := c.GetMemoriesBatch(context.Background(), "org-test", hashes)
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "forced batch error") {
		t.Fatalf("expected wrapped chunk error, got: %v", err)
	}
	if !strings.Contains(err.Error(), "chunk 2/3") {
		t.Fatalf("expected chunk metadata in error, got: %v", err)
	}
	if len(fake.callSizes) != 2 {
		t.Fatalf("expected calls to stop on second chunk failure, got %d calls", len(fake.callSizes))
	}
}

func buildDistinctHashes(n int) [][]byte {
	hashes := make([][]byte, 0, n)
	for i := 0; i < n; i++ {
		h := make([]byte, 32)
		h[0] = byte((i % 250) + 1)
		binary.BigEndian.PutUint32(h[28:], uint32(i+1))
		hashes = append(hashes, h)
	}
	return hashes
}

func hashMultisetFromHashes(hashes [][]byte) map[string]int {
	m := make(map[string]int, len(hashes))
	for _, h := range hashes {
		m[string(h)]++
	}
	return m
}

func hashMultisetFromResults(results []MemoryBatchResult) map[string]int {
	m := make(map[string]int, len(results))
	for _, result := range results {
		m[string(result.ContentHash)]++
	}
	return m
}
