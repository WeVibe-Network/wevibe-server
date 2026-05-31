package chain

import (
	"context"
	"fmt"
	"math"
	"strings"
	"testing"

	sdktypes "github.com/cosmos/cosmos-sdk/types"
	txtypes "github.com/cosmos/cosmos-sdk/types/tx"
	"google.golang.org/grpc"
)

type mockTxSimulator struct {
	gasUsed   uint64
	gasWanted uint64
	err       error
}

func (m *mockTxSimulator) Simulate(_ context.Context, _ *txtypes.SimulateRequest, _ ...grpc.CallOption) (*txtypes.SimulateResponse, error) {
	if m.err != nil {
		return nil, m.err
	}

	return &txtypes.SimulateResponse{
		GasInfo: &sdktypes.GasInfo{GasUsed: m.gasUsed, GasWanted: m.gasWanted},
	}, nil
}

func TestEstimateGasLimit_SimulateBufferMultiplier(t *testing.T) {
	client := &GrpcClient{txSim: &mockTxSimulator{gasUsed: 200_000, gasWanted: 200_000}}

	_, gasLimit, err := client.estimateGasLimit(context.Background(), gasStrategySimulateBuffer, []byte("tx"))
	if err != nil {
		t.Fatalf("estimate gas limit returned error: %v", err)
	}

	if gasLimit != 400_000 {
		t.Fatalf("unexpected gas limit: got %d want %d", gasLimit, 400_000)
	}
}

func TestEstimateGasLimit_SimulateRetryMultiplier(t *testing.T) {
	client := &GrpcClient{txSim: &mockTxSimulator{gasUsed: 200_000, gasWanted: 200_000}}

	_, gasLimit, err := client.estimateGasLimit(context.Background(), gasStrategySimulateRetry, []byte("tx"))
	if err != nil {
		t.Fatalf("estimate gas limit returned error: %v", err)
	}

	if gasLimit != 400_000 {
		t.Fatalf("unexpected gas limit: got %d want %d", gasLimit, 400_000)
	}
}

func TestEstimateGasLimit_UsesMaxGasWantedAndGasUsed(t *testing.T) {
	client := &GrpcClient{txSim: &mockTxSimulator{gasUsed: 36_667, gasWanted: 55_001}}

	simulatedGas, gasLimit, err := client.estimateGasLimit(context.Background(), gasStrategySimulateBuffer, []byte("tx"))
	if err != nil {
		t.Fatalf("estimate gas limit returned error: %v", err)
	}

	if simulatedGas != 55_001 {
		t.Fatalf("unexpected simulated gas: got %d want %d", simulatedGas, 55_001)
	}

	if gasLimit != 110_002 {
		t.Fatalf("unexpected gas limit: got %d want %d", gasLimit, 110_002)
	}
}

func TestEstimateGasLimit_IgnoresInfiniteGasWanted(t *testing.T) {
	client := &GrpcClient{txSim: &mockTxSimulator{gasUsed: 200_000, gasWanted: math.MaxUint64}}

	_, gasLimit, err := client.estimateGasLimit(context.Background(), gasStrategySimulateBuffer, []byte("tx"))
	if err != nil {
		t.Fatalf("estimate gas limit returned error: %v", err)
	}

	if gasLimit != 400_000 {
		t.Fatalf("unexpected gas limit: got %d want %d", gasLimit, 400_000)
	}
}

func TestRunSimulateRetryBroadcast_RetriesWithGasUsedTimesTwo(t *testing.T) {
	calledGasLimits := make([]uint64, 0, 2)
	callCount := 0

	txHash, _, err := runSimulateRetryBroadcast(
		400_000,
		maxOutOfGasRetries,
		func(gasLimit uint64) (broadcastCommitResult, error) {
			calledGasLimits = append(calledGasLimits, gasLimit)
			callCount++
			if callCount == 1 {
				return broadcastCommitResult{
					TxHash:  "tx-attempt-1",
					Code:    11,
					Log:     "out of gas in location",
					GasUsed: 200_050,
				}, nil
			}

			return broadcastCommitResult{
				TxHash:  "tx-attempt-2",
				Code:    0,
				GasUsed: 190_000,
			}, nil
		},
		nil,
	)
	if err != nil {
		t.Fatalf("runSimulateRetryBroadcast returned error: %v", err)
	}

	if txHash != "tx-attempt-2" {
		t.Fatalf("unexpected tx hash: got %q want %q", txHash, "tx-attempt-2")
	}

	if len(calledGasLimits) != 2 {
		t.Fatalf("unexpected call count: got %d want %d", len(calledGasLimits), 2)
	}

	if calledGasLimits[1] != 400_100 {
		t.Fatalf("unexpected retry gas limit: got %d want %d", calledGasLimits[1], 400_100)
	}
}

func TestRunSimulateRetryBroadcast_MaxRetryExhaustionIncludesAllAttempts(t *testing.T) {
	calledGasLimits := make([]uint64, 0, 4)
	logLines := make([]string, 0, 3)

	_, attempts, err := runSimulateRetryBroadcast(
		200_000,
		maxOutOfGasRetries,
		func(gasLimit uint64) (broadcastCommitResult, error) {
			calledGasLimits = append(calledGasLimits, gasLimit)
			return broadcastCommitResult{
				TxHash:  fmt.Sprintf("tx-attempt-%d", len(calledGasLimits)),
				Code:    11,
				Log:     "out of gas while executing",
				GasUsed: gasLimit + 50,
			}, nil
		},
		func(format string, args ...any) {
			logLines = append(logLines, fmt.Sprintf(format, args...))
		},
	)
	if err == nil {
		t.Fatalf("expected retry exhaustion error")
	}

	if !strings.Contains(err.Error(), "out-of-gas after 3 retries") {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(calledGasLimits) != 4 {
		t.Fatalf("unexpected attempt count: got %d want %d", len(calledGasLimits), 4)
	}

	if len(logLines) != 3 {
		t.Fatalf("unexpected escalation log count: got %d want %d", len(logLines), 3)
	}

	formattedAttempts := formatRetryAttempts(attempts)
	for _, gasLimit := range calledGasLimits {
		needle := fmt.Sprintf("gas=%d", gasLimit)
		if !strings.Contains(formattedAttempts, needle) {
			t.Fatalf("attempt log missing %q in %q", needle, formattedAttempts)
		}
	}
}

func TestParseGasStrategy_InvalidValueReturnsError(t *testing.T) {
	_, err := parseGasStrategy("invalid")
	if err == nil {
		t.Fatalf("expected parse error")
	}

	if !strings.Contains(err.Error(), "invalid GAS_STRATEGY") {
		t.Fatalf("unexpected error: %v", err)
	}
}
