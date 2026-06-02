package handlers

import (
	"bytes"
	"context"
	"fmt"
	"reflect"
	"testing"

	sdktypes "github.com/cosmos/cosmos-sdk/types"
	servetypes "github.com/wevibe-network/wevibe-chain/x/serve/types"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/chain"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/serves"
)

type markCall struct {
	ids    []int64
	txHash string
}

func TestRelayPendingEventsByOrgWithDeps_FoldsEpochsIntoSingleTxPreservingOrder(t *testing.T) {
	serveRecords := []serves.ServeEventRecord{
		makeServeRecord(1, 10, 0x11),
		makeServeRecord(2, 11, 0x21),
	}
	denialRecords := []serves.ServeEventRecord{
		makeDenialRecord(101, 10, 0x31),
		makeDenialRecord(102, 11, 0x41),
	}

	serveFetches := 0
	denialFetches := 0
	submitted := make([][]sdktypes.Msg, 0, 1)
	serveMarks := make([]markCall, 0, 1)
	denialMarks := make([]markCall, 0, 1)

	deps := relayPendingDeps{
		getPendingServes: func(context.Context, poolType, string, int) ([]serves.ServeEventRecord, error) {
			if serveFetches == 0 {
				serveFetches++
				return append([]serves.ServeEventRecord(nil), serveRecords...), nil
			}
			serveFetches++
			return nil, nil
		},
		getPendingDenials: func(context.Context, poolType, string, int) ([]serves.ServeEventRecord, error) {
			if denialFetches == 0 {
				denialFetches++
				return append([]serves.ServeEventRecord(nil), denialRecords...), nil
			}
			denialFetches++
			return nil, nil
		},
		submitRelayBatch: func(_ context.Context, _ *chain.GrpcClient, _ poolType, _ string, _ string, msgs []sdktypes.Msg) (string, error) {
			submitted = append(submitted, append([]sdktypes.Msg(nil), msgs...))
			return "tx-folded", nil
		},
		markServesSubmitted: func(_ context.Context, _ poolType, ids []int64, txHash string) error {
			serveMarks = append(serveMarks, markCall{ids: append([]int64(nil), ids...), txHash: txHash})
			return nil
		},
		markDenialsSubmitted: func(_ context.Context, _ poolType, ids []int64, txHash string) error {
			denialMarks = append(denialMarks, markCall{ids: append([]int64(nil), ids...), txHash: txHash})
			return nil
		},
		logRelayTxSubmission: func(string, int, int, string) {},
	}

	err := relayPendingEventsByOrgWithDeps(context.Background(), &chain.GrpcClient{}, nil, "org-1", deps)
	if err != nil {
		t.Fatalf("relayPendingEventsByOrgWithDeps returned error: %v", err)
	}

	if len(submitted) != 1 {
		t.Fatalf("expected 1 submitted tx, got %d", len(submitted))
	}
	if len(submitted[0]) != 4 {
		t.Fatalf("expected 4 messages in folded tx, got %d", len(submitted[0]))
	}

	assertServeMsgEpoch(t, submitted[0][0], 10)
	assertDenialMsgEpoch(t, submitted[0][1], 10)
	assertServeMsgEpoch(t, submitted[0][2], 11)
	assertDenialMsgEpoch(t, submitted[0][3], 11)

	if len(serveMarks) != 1 {
		t.Fatalf("expected 1 serve mark call, got %d", len(serveMarks))
	}
	if serveMarks[0].txHash != "tx-folded" {
		t.Fatalf("unexpected serve tx hash: got %q want %q", serveMarks[0].txHash, "tx-folded")
	}
	if !reflect.DeepEqual(serveMarks[0].ids, []int64{1, 2}) {
		t.Fatalf("unexpected serve IDs marked: got %v want %v", serveMarks[0].ids, []int64{1, 2})
	}

	if len(denialMarks) != 1 {
		t.Fatalf("expected 1 denial mark call, got %d", len(denialMarks))
	}
	if denialMarks[0].txHash != "tx-folded" {
		t.Fatalf("unexpected denial tx hash: got %q want %q", denialMarks[0].txHash, "tx-folded")
	}
	if !reflect.DeepEqual(denialMarks[0].ids, []int64{101, 102}) {
		t.Fatalf("unexpected denial IDs marked: got %v want %v", denialMarks[0].ids, []int64{101, 102})
	}
}

func TestRelayPendingEventsByOrgWithDeps_MessageCapFlushesAtEpochBoundary(t *testing.T) {
	serveRecords := make([]serves.ServeEventRecord, 0, 101)
	denialRecords := make([]serves.ServeEventRecord, 0, 101)
	for epoch := 1; epoch <= 101; epoch++ {
		seed := byte(epoch)
		serveRecords = append(serveRecords, makeServeRecord(int64(epoch), epoch, seed))
		denialRecords = append(denialRecords, makeDenialRecord(int64(1000+epoch), epoch, seed+100))
	}

	serveFetches := 0
	denialFetches := 0
	submitted := make([][]sdktypes.Msg, 0, 2)
	txCount := 0

	deps := relayPendingDeps{
		getPendingServes: func(context.Context, poolType, string, int) ([]serves.ServeEventRecord, error) {
			if serveFetches == 0 {
				serveFetches++
				return append([]serves.ServeEventRecord(nil), serveRecords...), nil
			}
			serveFetches++
			return nil, nil
		},
		getPendingDenials: func(context.Context, poolType, string, int) ([]serves.ServeEventRecord, error) {
			if denialFetches == 0 {
				denialFetches++
				return append([]serves.ServeEventRecord(nil), denialRecords...), nil
			}
			denialFetches++
			return nil, nil
		},
		submitRelayBatch: func(_ context.Context, _ *chain.GrpcClient, _ poolType, _ string, _ string, msgs []sdktypes.Msg) (string, error) {
			txCount++
			submitted = append(submitted, append([]sdktypes.Msg(nil), msgs...))
			return fmt.Sprintf("tx-%d", txCount), nil
		},
		markServesSubmitted:  func(context.Context, poolType, []int64, string) error { return nil },
		markDenialsSubmitted: func(context.Context, poolType, []int64, string) error { return nil },
		logRelayTxSubmission: func(string, int, int, string) {},
	}

	err := relayPendingEventsByOrgWithDeps(context.Background(), &chain.GrpcClient{}, nil, "org-cap", deps)
	if err != nil {
		t.Fatalf("relayPendingEventsByOrgWithDeps returned error: %v", err)
	}

	if len(submitted) != 2 {
		t.Fatalf("expected 2 submitted txs, got %d", len(submitted))
	}
	if len(submitted[0]) != maxRelayMsgsPerTx {
		t.Fatalf("unexpected first tx msg count: got %d want %d", len(submitted[0]), maxRelayMsgsPerTx)
	}
	if len(submitted[1]) != 2 {
		t.Fatalf("unexpected second tx msg count: got %d want %d", len(submitted[1]), 2)
	}

	assertServeMsgEpoch(t, submitted[0][198], 100)
	assertDenialMsgEpoch(t, submitted[0][199], 100)
	assertServeMsgEpoch(t, submitted[1][0], 101)
	assertDenialMsgEpoch(t, submitted[1][1], 101)
}

func TestRelayPendingEventsByOrgWithDeps_MarksIDsWithEachFlushedTxHash(t *testing.T) {
	serveRecords := make([]serves.ServeEventRecord, 0, 101)
	denialRecords := make([]serves.ServeEventRecord, 0, 101)
	for epoch := 1; epoch <= 101; epoch++ {
		seed := byte(epoch)
		serveRecords = append(serveRecords, makeServeRecord(int64(epoch), epoch, seed))
		denialRecords = append(denialRecords, makeDenialRecord(int64(1000+epoch), epoch, seed+100))
	}

	serveFetches := 0
	denialFetches := 0
	txCount := 0
	serveMarks := make([]markCall, 0, 2)
	denialMarks := make([]markCall, 0, 2)

	deps := relayPendingDeps{
		getPendingServes: func(context.Context, poolType, string, int) ([]serves.ServeEventRecord, error) {
			if serveFetches == 0 {
				serveFetches++
				return append([]serves.ServeEventRecord(nil), serveRecords...), nil
			}
			serveFetches++
			return nil, nil
		},
		getPendingDenials: func(context.Context, poolType, string, int) ([]serves.ServeEventRecord, error) {
			if denialFetches == 0 {
				denialFetches++
				return append([]serves.ServeEventRecord(nil), denialRecords...), nil
			}
			denialFetches++
			return nil, nil
		},
		submitRelayBatch: func(_ context.Context, _ *chain.GrpcClient, _ poolType, _ string, _ string, _ []sdktypes.Msg) (string, error) {
			txCount++
			return fmt.Sprintf("tx-%d", txCount), nil
		},
		markServesSubmitted: func(_ context.Context, _ poolType, ids []int64, txHash string) error {
			serveMarks = append(serveMarks, markCall{ids: append([]int64(nil), ids...), txHash: txHash})
			return nil
		},
		markDenialsSubmitted: func(_ context.Context, _ poolType, ids []int64, txHash string) error {
			denialMarks = append(denialMarks, markCall{ids: append([]int64(nil), ids...), txHash: txHash})
			return nil
		},
		logRelayTxSubmission: func(string, int, int, string) {},
	}

	err := relayPendingEventsByOrgWithDeps(context.Background(), &chain.GrpcClient{}, nil, "org-mark", deps)
	if err != nil {
		t.Fatalf("relayPendingEventsByOrgWithDeps returned error: %v", err)
	}

	if len(serveMarks) != 2 {
		t.Fatalf("expected 2 serve mark calls, got %d", len(serveMarks))
	}
	if len(denialMarks) != 2 {
		t.Fatalf("expected 2 denial mark calls, got %d", len(denialMarks))
	}

	if serveMarks[0].txHash != "tx-1" || denialMarks[0].txHash != "tx-1" {
		t.Fatalf("first flush tx hash mismatch: serve=%q denial=%q", serveMarks[0].txHash, denialMarks[0].txHash)
	}
	if serveMarks[1].txHash != "tx-2" || denialMarks[1].txHash != "tx-2" {
		t.Fatalf("second flush tx hash mismatch: serve=%q denial=%q", serveMarks[1].txHash, denialMarks[1].txHash)
	}

	if len(serveMarks[0].ids) != 100 || len(denialMarks[0].ids) != 100 {
		t.Fatalf("first flush IDs mismatch: serves=%d denials=%d", len(serveMarks[0].ids), len(denialMarks[0].ids))
	}
	if !reflect.DeepEqual(serveMarks[1].ids, []int64{101}) {
		t.Fatalf("unexpected second flush serve IDs: got %v want %v", serveMarks[1].ids, []int64{101})
	}
	if !reflect.DeepEqual(denialMarks[1].ids, []int64{1101}) {
		t.Fatalf("unexpected second flush denial IDs: got %v want %v", denialMarks[1].ids, []int64{1101})
	}
}

func makeServeRecord(id int64, epoch int, seed byte) serves.ServeEventRecord {
	return serves.ServeEventRecord{
		ID:                id,
		OrgID:             "org-test",
		EpochID:           epoch,
		MemoryContentHash: hex32(seed),
		ServeKey:          fmt.Sprintf("serve-key-%d", id),
		ContributorID:     fmt.Sprintf("contributor-%d", id),
		ContributorWallet: "wevibe1contributorwallet",
		Nullifier:         hex32(seed + 1),
		ModelID:           "model-1",
		TurnCount:         1,
		MatchedKeywords:   []string{"alpha"},
		ReporterPubkey:    fmt.Sprintf("reporter-%d", id),
		Reason:            "incorrect",
	}
}

func makeDenialRecord(id int64, epoch int, seed byte) serves.ServeEventRecord {
	record := makeServeRecord(id, epoch, seed)
	record.ServeKey = fmt.Sprintf("deny-key-%d", id)
	record.Reason = "spam"
	return record
}

func hex32(seed byte) string {
	return fmt.Sprintf("%x", bytes.Repeat([]byte{seed}, 32))
}

func assertServeMsgEpoch(t *testing.T, msg sdktypes.Msg, wantEpoch uint64) {
	t.Helper()
	serveMsg, ok := msg.(*servetypes.MsgSubmitServeBatch)
	if !ok {
		t.Fatalf("expected MsgSubmitServeBatch, got %T", msg)
	}
	if serveMsg.Epoch != wantEpoch {
		t.Fatalf("unexpected serve epoch: got %d want %d", serveMsg.Epoch, wantEpoch)
	}
}

func assertDenialMsgEpoch(t *testing.T, msg sdktypes.Msg, wantEpoch uint64) {
	t.Helper()
	denialMsg, ok := msg.(*servetypes.MsgSubmitDenialBatch)
	if !ok {
		t.Fatalf("expected MsgSubmitDenialBatch, got %T", msg)
	}
	if denialMsg.Epoch != wantEpoch {
		t.Fatalf("unexpected denial epoch: got %d want %d", denialMsg.Epoch, wantEpoch)
	}
}
