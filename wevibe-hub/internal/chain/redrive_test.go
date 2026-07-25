package chain

import (
	"context"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	coretypes "github.com/cometbft/cometbft/rpc/core/types"
	"github.com/jackc/pgx/v5"
	memorytypes "github.com/wevibe-network/wevibe-chain/x/memory/types"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
)

func TestRedriveApproveMemory_AlreadyCommittedNoop(t *testing.T) {
	w := &ChainWatcher{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	txSearchCalled := false

	err := w.redriveApproveMemory(
		context.Background(),
		"wevibe-org-0",
		"b354ccc30682cb6146dc50fa72627c7bb53d7b6c1ecee97f926a695c715fb759",
		func(context.Context, string, string) (string, error) { return protocol.SubmissionStatusCommitted, nil },
		func(context.Context, string, int, int) (*coretypes.ResultTxSearch, error) {
			txSearchCalled = true
			return nil, nil
		},
		nil,
		func([]byte) (TxInterface, error) { return nil, nil },
		nil,
	)
	if err != nil {
		t.Fatalf("redriveApproveMemory error: %v", err)
	}
	if txSearchCalled {
		t.Fatalf("txSearch should not be called for already-committed row")
	}
}

func TestRedriveApproveMemory_RowMissing(t *testing.T) {
	w := &ChainWatcher{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}

	err := w.redriveApproveMemory(
		context.Background(),
		"wevibe-org-0",
		"b354ccc30682cb6146dc50fa72627c7bb53d7b6c1ecee97f926a695c715fb759",
		func(context.Context, string, string) (string, error) { return "", pgx.ErrNoRows },
		nil,
		nil,
		nil,
		nil,
	)
	if err == nil {
		t.Fatalf("expected missing row error")
	}
	if !errors.Is(err, pgx.ErrNoRows) && err.Error() == "" {
		t.Fatalf("expected meaningful error for missing row")
	}
}

func TestRedriveApproveMemory_DispatchesBookkeepingWithTxFields(t *testing.T) {
	w := &ChainWatcher{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	contentHash := mustHex(t, "b354ccc30682cb6146dc50fa72627c7bb53d7b6c1ecee97f926a695c715fb759")
	txTime := time.Unix(1721829000, 0).UTC()

	tx := &coretypes.ResultTx{Hash: []byte{0x5E, 0x45}, Height: 4882, Tx: []byte{0x01, 0x02, 0x03}}
	txs := &coretypes.ResultTxSearch{Txs: []*coretypes.ResultTx{tx}, TotalCount: 1}

	called := false
	err := w.redriveApproveMemory(
		context.Background(),
		"wevibe-org-0",
		"b354ccc30682cb6146dc50fa72627c7bb53d7b6c1ecee97f926a695c715fb759",
		func(context.Context, string, string) (string, error) {
			return protocol.SubmissionStatusPendingChain, nil
		},
		func(context.Context, string, int, int) (*coretypes.ResultTxSearch, error) { return txs, nil },
		func(context.Context, int64) (time.Time, error) { return txTime, nil },
		func([]byte) (TxInterface, error) {
			return testTx{msgs: []interface{}{
				&memorytypes.MsgSubmitCommitment{
					OrgId:                  "wevibe-org-0",
					ContentHash:            contentHash,
					ContributorId:          "contributor-1",
					ContributorWallet:      "wevibe1wallet",
					ProducerModelId:        "gpt-5.3-codex",
					AttestationSessionHash: []byte{0xCA, 0xFE},
					Keywords: []*memorytypes.KeywordWeight{
						{Keyword: "alpha"},
						{Keyword: "beta"},
					},
				},
				&memorytypes.MsgApproveMemory{
					OrgId:         "wevibe-org-0",
					ContentHash:   contentHash,
					MemoryType:    memorytypes.MemoryType_MEMORY_TYPE_MEMORY,
					EncryptedBlob: []byte{0xAA},
					WrappedDekEnc: []byte{0xBB},
					McVersion:     9,
				},
			}}, nil
		},
		func(_ context.Context, txHash string, height int64, blockTime time.Time, orgID string, gotHash []byte, keywords []string, contributorID, contributorWallet, producerModelID, attestationSessionHash, memoryType string, encryptedBlob []byte, wrappedDekEnc []byte, mcVersion uint32) error {
			called = true
			if txHash != "5E45" {
				t.Fatalf("unexpected tx hash: %s", txHash)
			}
			if height != 4882 {
				t.Fatalf("unexpected height: %d", height)
			}
			if !blockTime.Equal(txTime) {
				t.Fatalf("unexpected block time: %s", blockTime)
			}
			if orgID != "wevibe-org-0" {
				t.Fatalf("unexpected org id: %s", orgID)
			}
			if string(gotHash) != string(contentHash) {
				t.Fatalf("unexpected content hash")
			}
			if len(keywords) != 2 || keywords[0] != "alpha" || keywords[1] != "beta" {
				t.Fatalf("unexpected keywords: %#v", keywords)
			}
			if contributorID != "contributor-1" || contributorWallet != "wevibe1wallet" {
				t.Fatalf("unexpected contributor fields: %s %s", contributorID, contributorWallet)
			}
			if producerModelID != "gpt-5.3-codex" {
				t.Fatalf("unexpected producer model id: %s", producerModelID)
			}
			if attestationSessionHash != "cafe" {
				t.Fatalf("unexpected attestation session hash: %s", attestationSessionHash)
			}
			if memoryType != "MEMORY_TYPE_MEMORY" {
				t.Fatalf("unexpected memory type: %s", memoryType)
			}
			if len(encryptedBlob) != 1 || encryptedBlob[0] != 0xAA {
				t.Fatalf("unexpected encrypted blob")
			}
			if len(wrappedDekEnc) != 1 || wrappedDekEnc[0] != 0xBB {
				t.Fatalf("unexpected wrapped DEK")
			}
			if mcVersion != 9 {
				t.Fatalf("unexpected mcVersion: %d", mcVersion)
			}
			return nil
		},
	)
	if err != nil {
		t.Fatalf("redriveApproveMemory error: %v", err)
	}
	if !called {
		t.Fatalf("bookkeeping callback was not called")
	}
}

type testTx struct{ msgs []interface{} }

func (t testTx) GetMsgs() []interface{} { return t.msgs }

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("decode hex: %v", err)
	}
	return b
}
