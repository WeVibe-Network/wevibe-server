package handlers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"reflect"
	"strings"
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
	outcomeMarks := make([]markCall, 0, 1)

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
		getPendingOutcomes: func(context.Context, poolType, string, int) ([]serves.OutcomeEventRecord, error) {
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
		markOutcomes: func(_ context.Context, _ poolType, ids []int64, _ string, txHash string) error {
			outcomeMarks = append(outcomeMarks, markCall{ids: append([]int64(nil), ids...), txHash: txHash})
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
	if len(outcomeMarks) != 1 || len(outcomeMarks[0].ids) != 0 {
		t.Fatalf("unexpected outcome marks for no outcome events: %+v", outcomeMarks)
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
		getPendingOutcomes: func(context.Context, poolType, string, int) ([]serves.OutcomeEventRecord, error) {
			return nil, nil
		},
		submitRelayBatch: func(_ context.Context, _ *chain.GrpcClient, _ poolType, _ string, _ string, msgs []sdktypes.Msg) (string, error) {
			txCount++
			submitted = append(submitted, append([]sdktypes.Msg(nil), msgs...))
			return fmt.Sprintf("tx-%d", txCount), nil
		},
		markServesSubmitted:  func(context.Context, poolType, []int64, string) error { return nil },
		markDenialsSubmitted: func(context.Context, poolType, []int64, string) error { return nil },
		markOutcomes:         func(context.Context, poolType, []int64, string, string) error { return nil },
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
		getPendingOutcomes: func(context.Context, poolType, string, int) ([]serves.OutcomeEventRecord, error) {
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
		markOutcomes:         func(context.Context, poolType, []int64, string, string) error { return nil },
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

func TestRelayPendingEventsByOrgWithDeps_FoldsOutcomeEvents(t *testing.T) {
	outcomes := []serves.OutcomeEventRecord{
		makeOutcomeRecord(201, 10, 0x51),
		makeOutcomeRecord(202, 11, 0x61),
	}
	outcomeFetches := 0
	submitted := make([][]sdktypes.Msg, 0, 1)
	outcomeMarks := make([]markCall, 0, 1)

	deps := relayPendingDeps{
		getPendingServes:  func(context.Context, poolType, string, int) ([]serves.ServeEventRecord, error) { return nil, nil },
		getPendingDenials: func(context.Context, poolType, string, int) ([]serves.ServeEventRecord, error) { return nil, nil },
		getPendingOutcomes: func(context.Context, poolType, string, int) ([]serves.OutcomeEventRecord, error) {
			if outcomeFetches == 0 {
				outcomeFetches++
				return append([]serves.OutcomeEventRecord(nil), outcomes...), nil
			}
			outcomeFetches++
			return nil, nil
		},
		submitRelayBatch: func(_ context.Context, _ *chain.GrpcClient, _ poolType, _ string, _ string, msgs []sdktypes.Msg) (string, error) {
			submitted = append(submitted, append([]sdktypes.Msg(nil), msgs...))
			return "tx-outcome", nil
		},
		markServesSubmitted:  func(context.Context, poolType, []int64, string) error { return nil },
		markDenialsSubmitted: func(context.Context, poolType, []int64, string) error { return nil },
		markOutcomes: func(_ context.Context, _ poolType, ids []int64, status, txHash string) error {
			if status != "submitted" {
				t.Fatalf("unexpected outcome status: %s", status)
			}
			outcomeMarks = append(outcomeMarks, markCall{ids: append([]int64(nil), ids...), txHash: txHash})
			return nil
		},
		logRelayTxSubmission: func(string, int, int, string) {},
	}

	err := relayPendingEventsByOrgWithDeps(context.Background(), &chain.GrpcClient{}, nil, "org-test", deps)
	if err != nil {
		t.Fatalf("relayPendingEventsByOrgWithDeps returned error: %v", err)
	}
	if len(submitted) != 1 || len(submitted[0]) != 2 {
		t.Fatalf("expected one tx with two outcome messages, got %+v", submitted)
	}
	assertOutcomeMsgEpoch(t, submitted[0][0], 10)
	assertOutcomeMsgEpoch(t, submitted[0][1], 11)
	if len(outcomeMarks) != 1 || !reflect.DeepEqual(outcomeMarks[0].ids, []int64{201, 202}) || outcomeMarks[0].txHash != "tx-outcome" {
		t.Fatalf("unexpected outcome marks: %+v", outcomeMarks)
	}
}

func TestCanonicalOutcomeEventBody_ChainGoldenVector(t *testing.T) {
	serveRef := bytes.Repeat([]byte{0x13}, 32)
	entry := &servetypes.EventEntry{Body: &servetypes.EventEntry_Outcome{Outcome: &servetypes.OutcomeEventBody{
		EpisodeRef: []byte{0x10, 0x11}, Worked: true, EvidenceRef: []byte{0x12}, ServeRef: serveRef,
	}}}
	body, err := servetypes.CanonicalEventBody(servetypes.EventType_EVENT_TYPE_OUTCOME, "org-a", bytes.Repeat([]byte{0x01}, 32), 7, bytes.Repeat([]byte{0x02}, 32), []byte{0x03, 0x04}, entry)
	if err != nil {
		t.Fatalf("CanonicalEventBody returned error: %v", err)
	}
	expected := "wevibe-event-v1\noutcome\norg-a\n" + strings.Repeat("01", 32) + "\n7\n" + strings.Repeat("02", 32) + "\n1011\nworked=true\n12\n" + strings.Repeat("13", 32) + "\n0304"
	if string(body) != expected {
		t.Fatalf("canonical body mismatch:\ngot  %q\nwant %q", string(body), expected)
	}
	sum := sha256.Sum256([]byte(expected))
	if got := fmt.Sprintf("%x", servetypes.ComputeEventFingerprint(body)); got != fmt.Sprintf("%x", sum[:]) {
		t.Fatalf("fingerprint mismatch: got %s want %x", got, sum[:])
	}
}

func TestCanonicalOutcomeRequestBody_RequiresServeRef32Bytes(t *testing.T) {
	base := validOutcomeRequestForCanonicalTest(t)
	tests := []struct {
		name     string
		serveRef string
		wantErr  string
	}{
		{name: "missing", serveRef: "", wantErr: "serve_ref is required"},
		{name: "31 bytes", serveRef: strings.Repeat("13", 31), wantErr: "serve_ref must be exactly 32 bytes"},
		{name: "33 bytes", serveRef: strings.Repeat("13", 33), wantErr: "serve_ref must be exactly 32 bytes"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateServeRefIntake(tt.serveRef)
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("validateServeRefIntake error = %v, want containing %q", err, tt.wantErr)
			}

			req := base
			req.ServeRef = tt.serveRef
			_, _, _, err = canonicalOutcomeRequestBody(req)
			if err == nil {
				t.Fatalf("canonicalOutcomeRequestBody succeeded with invalid serve_ref %q", tt.serveRef)
			}
		})
	}
}

func TestCanonicalOutcomeRequestBody_ByteMatchesChainConstructionWithServeRef(t *testing.T) {
	req := validOutcomeRequestForCanonicalTest(t)
	body, _, _, err := canonicalOutcomeRequestBody(req)
	if err != nil {
		t.Fatalf("canonicalOutcomeRequestBody returned error: %v", err)
	}

	entry := &servetypes.EventEntry{Body: &servetypes.EventEntry_Outcome{Outcome: &servetypes.OutcomeEventBody{
		EpisodeRef:  []byte{0x10, 0x11},
		Worked:      true,
		EvidenceRef: []byte{0x12},
		ServeRef:    bytes.Repeat([]byte{0x13}, 32),
	}}}
	want, err := servetypes.CanonicalEventBody(servetypes.EventType_EVENT_TYPE_OUTCOME, req.OrgID, bytes.Repeat([]byte{0x01}, 32), uint64(req.EpochID), bytes.Repeat([]byte{0x02}, 32), []byte{0x03, 0x04}, entry)
	if err != nil {
		t.Fatalf("CanonicalEventBody returned error: %v", err)
	}
	if !bytes.Equal(body, want) {
		t.Fatalf("canonical request body mismatch:\ngot  %q\nwant %q", string(body), string(want))
	}
}

func validOutcomeRequestForCanonicalTest(t *testing.T) serves.RecordOutcomeRequest {
	t.Helper()
	return serves.RecordOutcomeRequest{
		OrgID:             "org-a",
		EpochID:           7,
		EventType:         serves.EventTypeOutcome,
		MemoryContentHash: strings.Repeat("01", 32),
		SignerPubkey:      strings.Repeat("02", 32),
		Nonce:             "0304",
		Signature:         strings.Repeat("04", 64),
		EpisodeRef:        "1011",
		ServeRef:          strings.Repeat("13", 32),
		Worked:            true,
		EvidenceRef:       "12",
		Fingerprint:       strings.Repeat("05", 32),
	}
}

func makeServeRecord(id int64, epoch int, seed byte) serves.ServeEventRecord {
	return serves.ServeEventRecord{
		ID:                id,
		OrgID:             "org-test",
		EpochID:           epoch,
		MemoryContentHash: hex32(seed),
		ServeKeyPubkey:    hex32(seed + 1),
		ServeSig:          hex64(seed + 2),
		ServeFingerprint:  hex32(seed + 4),
		Nonce:             fmt.Sprintf("%02x", seed+3),
		ContributorID:     fmt.Sprintf("contributor-%d", id),
		ContributorWallet: "wevibe1contributorwallet",
		ModelID:           "model-1",
		TurnCount:         1,
		MatchedKeywords:   []string{"alpha"},
		ReporterPubkey:    fmt.Sprintf("reporter-%d", id),
		Reason:            "incorrect",
	}
}

func makeDenialRecord(id int64, epoch int, seed byte) serves.ServeEventRecord {
	record := makeServeRecord(id, epoch, seed)
	record.ServeFingerprint = hex32(seed + 4)
	record.Reason = "spam"
	return record
}

func makeOutcomeRecord(id int64, epoch int, seed byte) serves.OutcomeEventRecord {
	entry := &servetypes.EventEntry{Body: &servetypes.EventEntry_Outcome{Outcome: &servetypes.OutcomeEventBody{
		EpisodeRef:  []byte{seed + 4},
		Worked:      true,
		EvidenceRef: []byte{seed + 5},
		ServeRef:    bytes.Repeat([]byte{seed + 6}, 32),
	}}}
	if _, err := servetypes.CanonicalEventBody(servetypes.EventType_EVENT_TYPE_OUTCOME, "org-test", bytes.Repeat([]byte{seed}, 32), uint64(epoch), bytes.Repeat([]byte{seed + 1}, 32), []byte{seed + 2}, entry); err != nil {
		panic(err)
	}
	return serves.OutcomeEventRecord{
		ID:                id,
		OrgID:             "org-test",
		EpochID:           epoch,
		MemoryContentHash: hex32(seed),
		SignerPubkey:      hex32(seed + 1),
		Nonce:             fmt.Sprintf("%02x", seed+2),
		Signature:         hex64(seed + 3),
		EpisodeRef:        fmt.Sprintf("%02x", seed+4),
		ServeRef:          hex32(seed + 6),
		Worked:            true,
		EvidenceRef:       fmt.Sprintf("%02x", seed+5),
		Fingerprint:       "",
		ReporterPubkey:    fmt.Sprintf("reporter-%d", id),
	}
}

func hex32(seed byte) string {
	return fmt.Sprintf("%x", bytes.Repeat([]byte{seed}, 32))
}

func hex64(seed byte) string {
	return fmt.Sprintf("%x", bytes.Repeat([]byte{seed}, 64))
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

func assertOutcomeMsgEpoch(t *testing.T, msg sdktypes.Msg, wantEpoch uint64) {
	t.Helper()
	outcomeMsg, ok := msg.(*servetypes.MsgSubmitEventBatch)
	if !ok {
		t.Fatalf("expected MsgSubmitEventBatch, got %T", msg)
	}
	if outcomeMsg.Epoch != wantEpoch {
		t.Fatalf("unexpected outcome epoch: got %d want %d", outcomeMsg.Epoch, wantEpoch)
	}
}
