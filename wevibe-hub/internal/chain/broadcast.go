package chain

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"time"

	sdkmath "cosmossdk.io/math"
	cryptotypes "github.com/cosmos/cosmos-sdk/crypto/types"
	"github.com/cosmos/cosmos-sdk/types"
	txtypes "github.com/cosmos/cosmos-sdk/types/tx"
	"github.com/cosmos/cosmos-sdk/types/tx/signing"
	authsigning "github.com/cosmos/cosmos-sdk/x/auth/signing"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	banktypes "github.com/cosmos/cosmos-sdk/x/bank/types"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	DefaultFeeDenom              = "uvibe"
	DefaultFeeAmount             = int64(2000)
	BroadcastTimeout             = 30 * time.Second
	accountQueryRetryAttempts    = 8
	maxOutOfGasRetries           = 3
	simulateSeedGasLimit         = uint64(1)
	minGasPriceNum               = int64(25)
	minGasPriceDen               = int64(1000)
	MIN_GAS_BALANCE              = int64(5_000_000)
	TOPUP_AMOUNT                 = int64(20_000_000)
	simulateBufferMultiplierNum  = uint64(2)
	simulateBufferMultiplierDen  = uint64(1)
	simulateRetryMultiplier      = uint64(2)
	gasStrategySimulateBufferRaw = "simulate-buffer"
	gasStrategySimulateRetryRaw  = "simulate-retry"
)

type txBroadcastMode uint8

const (
	txBroadcastModeSync txBroadcastMode = iota
	txBroadcastModeCommit
)

type gasStrategy string

const (
	gasStrategySimulateBuffer gasStrategy = gasStrategySimulateBufferRaw
	gasStrategySimulateRetry  gasStrategy = gasStrategySimulateRetryRaw
)

type txSimulator interface {
	Simulate(ctx context.Context, in *txtypes.SimulateRequest, opts ...grpc.CallOption) (*txtypes.SimulateResponse, error)
}

type broadcastCommitResult struct {
	TxHash     string
	Code       uint32
	Codespace  string
	Log        string
	GasWanted  uint64
	GasUsed    uint64
	RawLogLine string
}

type gasRetryAttempt struct {
	Attempt   int
	GasLimit  uint64
	DeliverTx broadcastCommitResult
	Err       string
}

type rpcBroadcastTxCommitResponse struct {
	Result *struct {
		CheckTx  rpcABCIResponse `json:"check_tx"`
		TxResult rpcABCIResponse `json:"tx_result"`
		Hash     string          `json:"hash"`
	} `json:"result"`
	Error *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Data    string `json:"data"`
	} `json:"error"`
}

type rpcABCIResponse struct {
	Code      uint32          `json:"code"`
	Codespace string          `json:"codespace"`
	Log       string          `json:"log"`
	GasWanted json.RawMessage `json:"gas_wanted"`
	GasUsed   json.RawMessage `json:"gas_used"`
}

func isTransientStoreStateError(err error) bool {
	if err == nil {
		return false
	}

	errMsg := err.Error()
	return strings.Contains(errMsg, "version does not exist") ||
		strings.Contains(errMsg, "failed to load state")
}

func retryBackoff(attempt int) time.Duration {
	return time.Duration(attempt) * 400 * time.Millisecond
}

func parseGasStrategy(raw string) (gasStrategy, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return gasStrategySimulateBuffer, nil
	}

	mode := gasStrategy(value)
	switch mode {
	case gasStrategySimulateBuffer, gasStrategySimulateRetry:
		return mode, nil
	default:
		return "", fmt.Errorf("invalid GAS_STRATEGY %q (valid values: %s, %s)", value, gasStrategySimulateBufferRaw, gasStrategySimulateRetryRaw)
	}
}

func gasLimitFromSimulation(simulatedGas uint64, mode gasStrategy) (uint64, error) {
	if simulatedGas == 0 {
		return 0, fmt.Errorf("simulated gas is zero")
	}

	switch mode {
	case gasStrategySimulateBuffer:
		if simulatedGas > math.MaxUint64/simulateBufferMultiplierNum {
			return 0, fmt.Errorf("simulated gas %d overflows buffer multiplier", simulatedGas)
		}

		scaled := simulatedGas * simulateBufferMultiplierNum
		if scaled%simulateBufferMultiplierDen != 0 {
			scaled += simulateBufferMultiplierDen - (scaled % simulateBufferMultiplierDen)
		}

		return scaled / simulateBufferMultiplierDen, nil
	case gasStrategySimulateRetry:
		if simulatedGas > math.MaxUint64/simulateRetryMultiplier {
			return 0, fmt.Errorf("simulated gas %d overflows retry multiplier", simulatedGas)
		}

		return simulatedGas * simulateRetryMultiplier, nil
	default:
		return 0, fmt.Errorf("unsupported gas strategy %q", mode)
	}
}

func feeAmountFromGasLimit(gasLimit uint64) (int64, error) {
	if gasLimit > uint64(math.MaxInt64) {
		return 0, fmt.Errorf("gas limit %d exceeds int64 range", gasLimit)
	}

	gasLimitInt := int64(gasLimit)
	if gasLimitInt > math.MaxInt64/minGasPriceNum {
		return 0, fmt.Errorf("gas limit %d overflows fee calculation", gasLimit)
	}

	feeAmount := (gasLimitInt * minGasPriceNum) / minGasPriceDen
	if (gasLimitInt*minGasPriceNum)%minGasPriceDen != 0 {
		feeAmount++
	}
	if feeAmount < DefaultFeeAmount {
		feeAmount = DefaultFeeAmount
	}

	return feeAmount, nil
}

func parseUint64JSON(raw json.RawMessage) (uint64, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return 0, nil
	}

	var numeric uint64
	if err := json.Unmarshal(raw, &numeric); err == nil {
		return numeric, nil
	}

	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return 0, fmt.Errorf("decode uint64 JSON value %q", trimmed)
	}

	text = strings.TrimSpace(text)
	if text == "" {
		return 0, nil
	}

	parsed, err := strconv.ParseUint(text, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parse uint64 %q: %w", text, err)
	}

	return parsed, nil
}

func isOutOfGasDeliverTx(result broadcastCommitResult) bool {
	if result.Code == 0 {
		return false
	}

	msg := strings.ToLower(result.Log + " " + result.RawLogLine)
	return strings.Contains(msg, "out of gas")
}

func nextEscalatedGasLimit(gasUsed uint64) (uint64, error) {
	if gasUsed == 0 {
		return 0, fmt.Errorf("out-of-gas response did not include gas_used")
	}
	if gasUsed > math.MaxUint64/2 {
		return 0, fmt.Errorf("gas_used %d overflows retry escalation", gasUsed)
	}
	return gasUsed * 2, nil
}

func formatRetryAttempts(attempts []gasRetryAttempt) string {
	parts := make([]string, 0, len(attempts))
	for _, attempt := range attempts {
		if attempt.Err != "" {
			parts = append(parts, fmt.Sprintf("attempt=%d gas=%d err=%q", attempt.Attempt, attempt.GasLimit, attempt.Err))
			continue
		}

		parts = append(parts, fmt.Sprintf(
			"attempt=%d gas=%d code=%d gas_used=%d log=%q",
			attempt.Attempt,
			attempt.GasLimit,
			attempt.DeliverTx.Code,
			attempt.DeliverTx.GasUsed,
			attempt.DeliverTx.Log,
		))
	}

	return strings.Join(parts, "; ")
}

func maxUint64(a, b uint64) uint64 {
	if a > b {
		return a
	}
	return b
}

type rpcBroadcastTxSyncResponse struct {
	Result *struct {
		Code      uint32 `json:"code"`
		Codespace string `json:"codespace"`
		Log       string `json:"log"`
		Hash      string `json:"hash"`
	} `json:"result"`
	Error *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Data    string `json:"data"`
	} `json:"error"`
}

func (c *GrpcClient) broadcastTxSync(ctx context.Context, txBytes []byte) (string, error) {
	if c.rpcURL == "" {
		return "", fmt.Errorf("WEVIBE_CHAIN_RPC_URL is required for tx broadcast")
	}

	payload := map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      "wevibe-hub",
		"method":  "broadcast_tx_sync",
		"params": map[string]string{
			"tx": base64.StdEncoding.EncodeToString(txBytes),
		},
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("marshal rpc request: %w", err)
	}

	rpcURL := strings.TrimRight(c.rpcURL, "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, rpcURL, bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("build rpc request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("rpc request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read rpc response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("rpc status %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}

	var parsed rpcBroadcastTxSyncResponse
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return "", fmt.Errorf("decode rpc response: %w", err)
	}

	if parsed.Error != nil {
		if parsed.Error.Data != "" {
			return "", fmt.Errorf("rpc error: code = %d message = %s data = %s", parsed.Error.Code, parsed.Error.Message, parsed.Error.Data)
		}
		return "", fmt.Errorf("rpc error: code = %d message = %s", parsed.Error.Code, parsed.Error.Message)
	}

	if parsed.Result == nil {
		return "", fmt.Errorf("rpc response missing result")
	}

	if parsed.Result.Code != 0 {
		return "", fmt.Errorf("codespace %s code %d: %s", parsed.Result.Codespace, parsed.Result.Code, parsed.Result.Log)
	}

	if parsed.Result.Hash == "" {
		return "", fmt.Errorf("rpc response missing tx hash")
	}

	return parsed.Result.Hash, nil
}

func (c *GrpcClient) broadcastTxCommit(ctx context.Context, txBytes []byte) (broadcastCommitResult, error) {
	if c.rpcURL == "" {
		return broadcastCommitResult{}, fmt.Errorf("WEVIBE_CHAIN_RPC_URL is required for tx broadcast")
	}

	payload := map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      "wevibe-hub",
		"method":  "broadcast_tx_commit",
		"params": map[string]string{
			"tx": base64.StdEncoding.EncodeToString(txBytes),
		},
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return broadcastCommitResult{}, fmt.Errorf("marshal rpc request: %w", err)
	}

	rpcURL := strings.TrimRight(c.rpcURL, "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, rpcURL, bytes.NewReader(body))
	if err != nil {
		return broadcastCommitResult{}, fmt.Errorf("build rpc request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return broadcastCommitResult{}, fmt.Errorf("rpc request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return broadcastCommitResult{}, fmt.Errorf("read rpc response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return broadcastCommitResult{}, fmt.Errorf("rpc status %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}

	var parsed rpcBroadcastTxCommitResponse
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return broadcastCommitResult{}, fmt.Errorf("decode rpc response: %w", err)
	}

	if parsed.Error != nil {
		if parsed.Error.Data != "" {
			return broadcastCommitResult{}, fmt.Errorf("rpc error: code = %d message = %s data = %s", parsed.Error.Code, parsed.Error.Message, parsed.Error.Data)
		}
		return broadcastCommitResult{}, fmt.Errorf("rpc error: code = %d message = %s", parsed.Error.Code, parsed.Error.Message)
	}

	if parsed.Result == nil {
		return broadcastCommitResult{}, fmt.Errorf("rpc response missing result")
	}

	if parsed.Result.CheckTx.Code != 0 {
		return broadcastCommitResult{}, fmt.Errorf(
			"check_tx failed: codespace %s code %d: %s",
			parsed.Result.CheckTx.Codespace,
			parsed.Result.CheckTx.Code,
			parsed.Result.CheckTx.Log,
		)
	}

	if parsed.Result.Hash == "" {
		return broadcastCommitResult{}, fmt.Errorf("rpc response missing tx hash")
	}

	gasWanted, err := parseUint64JSON(parsed.Result.TxResult.GasWanted)
	if err != nil {
		return broadcastCommitResult{}, fmt.Errorf("parse tx_result.gas_wanted: %w", err)
	}

	gasUsed, err := parseUint64JSON(parsed.Result.TxResult.GasUsed)
	if err != nil {
		return broadcastCommitResult{}, fmt.Errorf("parse tx_result.gas_used: %w", err)
	}

	return broadcastCommitResult{
		TxHash:     parsed.Result.Hash,
		Code:       parsed.Result.TxResult.Code,
		Codespace:  parsed.Result.TxResult.Codespace,
		Log:        parsed.Result.TxResult.Log,
		GasWanted:  gasWanted,
		GasUsed:    gasUsed,
		RawLogLine: string(respBody),
	}, nil
}

func (c *GrpcClient) simulateGas(ctx context.Context, txBytes []byte) (uint64, error) {
	if c.txSim == nil {
		return 0, fmt.Errorf("tx simulation client is not configured")
	}

	res, err := c.txSim.Simulate(ctx, &txtypes.SimulateRequest{TxBytes: txBytes})
	if err != nil {
		return 0, fmt.Errorf("simulate tx: %w", err)
	}
	if res == nil || res.GasInfo == nil {
		return 0, fmt.Errorf("simulate tx: missing gas info")
	}

	simulatedGas := res.GasInfo.GasUsed
	if res.GasInfo.GasWanted > 0 && res.GasInfo.GasWanted <= txtypes.MaxGasWanted {
		simulatedGas = maxUint64(simulatedGas, res.GasInfo.GasWanted)
	}
	if simulatedGas == 0 {
		return 0, fmt.Errorf("simulate tx: gas info returned zero gas")
	}

	return simulatedGas, nil
}

func (c *GrpcClient) estimateGasLimit(ctx context.Context, mode gasStrategy, simulationTxBytes []byte) (uint64, uint64, error) {
	simulatedGas, err := c.simulateGas(ctx, simulationTxBytes)
	if err != nil {
		return 0, 0, err
	}

	gasLimit, err := gasLimitFromSimulation(simulatedGas, mode)
	if err != nil {
		return 0, 0, err
	}

	return simulatedGas, gasLimit, nil
}

func (c *GrpcClient) buildSignedTxBytes(
	ctx context.Context,
	msgs []types.Msg,
	pubkey cryptotypes.PubKey,
	signerAddress string,
	keyringUID string,
	accNum uint64,
	accSeq uint64,
	gasLimit uint64,
	signMode signing.SignMode,
) ([]byte, error) {
	txBuilder := c.txConfig.NewTxBuilder()
	if err := txBuilder.SetMsgs(msgs...); err != nil {
		return nil, fmt.Errorf("set tx messages: %w", err)
	}

	feeAmount, err := feeAmountFromGasLimit(gasLimit)
	if err != nil {
		return nil, err
	}

	txBuilder.SetGasLimit(gasLimit)
	txBuilder.SetFeeAmount(types.NewCoins(types.NewInt64Coin(DefaultFeeDenom, feeAmount)))

	if err := txBuilder.SetSignatures(signing.SignatureV2{
		PubKey: pubkey,
		Data: &signing.SingleSignatureData{
			SignMode:  signMode,
			Signature: nil,
		},
		Sequence: accSeq,
	}); err != nil {
		return nil, fmt.Errorf("set empty signatures: %w", err)
	}

	signerData := authsigning.SignerData{
		Address:       signerAddress,
		ChainID:       c.chainID,
		AccountNumber: accNum,
		Sequence:      accSeq,
		PubKey:        pubkey,
	}

	signBytes, err := authsigning.GetSignBytesAdapter(
		ctx, c.txConfig.SignModeHandler(), signMode, signerData, txBuilder.GetTx(),
	)
	if err != nil {
		return nil, fmt.Errorf("get sign bytes: %w", err)
	}

	sigBytes, _, err := c.kr.Sign(keyringUID, signBytes, signMode)
	if err != nil {
		return nil, fmt.Errorf("sign: %w", err)
	}

	if err := txBuilder.SetSignatures(signing.SignatureV2{
		PubKey: pubkey,
		Data: &signing.SingleSignatureData{
			SignMode:  signMode,
			Signature: sigBytes,
		},
		Sequence: accSeq,
	}); err != nil {
		return nil, fmt.Errorf("set signatures: %w", err)
	}

	txBytes, err := c.txConfig.TxEncoder()(txBuilder.GetTx())
	if err != nil {
		return nil, fmt.Errorf("encode tx: %w", err)
	}

	return txBytes, nil
}

func runSimulateRetryBroadcast(
	initialGasLimit uint64,
	maxRetries int,
	broadcastFn func(gasLimit uint64) (broadcastCommitResult, error),
	logFn func(string, ...any),
) (string, []gasRetryAttempt, error) {
	if logFn == nil {
		logFn = func(string, ...any) {}
	}

	gasLimit := initialGasLimit
	attempts := make([]gasRetryAttempt, 0, maxRetries+1)

	for attempt := 1; attempt <= maxRetries+1; attempt++ {
		result, err := broadcastFn(gasLimit)
		if err != nil {
			attempts = append(attempts, gasRetryAttempt{
				Attempt:  attempt,
				GasLimit: gasLimit,
				Err:      err.Error(),
			})
			return "", attempts, fmt.Errorf("broadcast attempt %d failed: %w; attempts: %s", attempt, err, formatRetryAttempts(attempts))
		}

		attempts = append(attempts, gasRetryAttempt{
			Attempt:   attempt,
			GasLimit:  gasLimit,
			DeliverTx: result,
		})

		if result.Code == 0 {
			return result.TxHash, attempts, nil
		}

		if !isOutOfGasDeliverTx(result) {
			return "", attempts, fmt.Errorf("deliver tx failed: codespace %s code %d: %s; attempts: %s", result.Codespace, result.Code, result.Log, formatRetryAttempts(attempts))
		}

		if attempt > maxRetries {
			return "", attempts, fmt.Errorf("out-of-gas after %d retries; attempts: %s", maxRetries, formatRetryAttempts(attempts))
		}

		nextGasLimit, err := nextEscalatedGasLimit(result.GasUsed)
		if err != nil {
			return "", attempts, fmt.Errorf("%w; attempts: %s", err, formatRetryAttempts(attempts))
		}

		logFn(
			"simulate-retry out-of-gas: attempt=%d/%d gas_limit=%d gas_used=%d next_gas_limit=%d",
			attempt,
			maxRetries+1,
			gasLimit,
			result.GasUsed,
			nextGasLimit,
		)

		gasLimit = nextGasLimit
	}

	return "", attempts, fmt.Errorf("simulate-retry exhausted")
}

func (c *GrpcClient) BroadcastMsgsForOrgServing(ctx context.Context, db *pgxpool.Pool, faucetURL, orgID string, msgs ...types.Msg) (*types.TxResponse, error) {
	return c.broadcastMsgsForOrg(ctx, db, faucetURL, orgID, OrgKeyServing, txBroadcastModeSync, msgs...)
}

func (c *GrpcClient) BroadcastMsgsForOrgServingCommit(ctx context.Context, db *pgxpool.Pool, faucetURL, orgID string, msgs ...types.Msg) (*types.TxResponse, error) {
	return c.broadcastMsgsForOrg(ctx, db, faucetURL, orgID, OrgKeyServing, txBroadcastModeCommit, msgs...)
}

func (c *GrpcClient) BroadcastMsgsForOrgLeader(ctx context.Context, db *pgxpool.Pool, faucetURL, orgID string, msgs ...types.Msg) (*types.TxResponse, error) {
	return c.broadcastMsgsForOrg(ctx, db, faucetURL, orgID, OrgKeyLeader, txBroadcastModeSync, msgs...)
}

func (c *GrpcClient) broadcastMsgsForOrg(ctx context.Context, db *pgxpool.Pool, faucetURL, orgID string, role OrgKeyRole, mode txBroadcastMode, msgs ...types.Msg) (*types.TxResponse, error) {
	if len(msgs) == 0 {
		return nil, fmt.Errorf("no messages to broadcast")
	}

	signer, err := c.GetOrgSigner(ctx, db, orgID, role)
	if err != nil {
		return nil, fmt.Errorf("resolve org signer: %w", err)
	}

	signer.mu.Lock()
	defer signer.mu.Unlock()

	for _, msg := range msgs {
		if err := setMsgSigner(msg, signer.addressStr); err != nil {
			return nil, err
		}
	}

	if err := c.loadOrgSignerState(ctx, faucetURL, signer); err != nil {
		return nil, err
	}

	if err := c.ensureOrgSignerBalance(ctx, faucetURL, signer); err != nil {
		return nil, err
	}

	response, err := c.broadcastSignedMsgsForOrg(ctx, signer, mode, msgs...)
	if err == nil {
		signer.nextSeq++
		return response, nil
	}

	if !isIncorrectAccountSequenceError(err) {
		return nil, err
	}

	signer.seqLoaded = false
	if reloadErr := c.loadOrgSignerState(ctx, faucetURL, signer); reloadErr != nil {
		return nil, fmt.Errorf("reload signer sequence after mismatch: %w", reloadErr)
	}

	retryResponse, retryErr := c.broadcastSignedMsgsForOrg(ctx, signer, mode, msgs...)
	if retryErr != nil {
		return nil, retryErr
	}

	signer.nextSeq++
	return retryResponse, nil
}

func (c *GrpcClient) loadOrgSignerState(ctx context.Context, faucetURL string, signer *orgSigner) error {
	if signer.seqLoaded {
		return nil
	}

	accountNum, nextSeq, err := c.querySignerAccountState(ctx, signer.addressStr)
	if err == nil {
		signer.accountNum = accountNum
		signer.nextSeq = nextSeq
		signer.seqLoaded = true
		return nil
	}

	if !isAccountNotFoundError(err) {
		return err
	}

	if err := fundFromFaucet(ctx, faucetURL, signer.addressStr, TOPUP_AMOUNT); err != nil {
		return fmt.Errorf("fund org signer %s: %w", signer.addressStr, err)
	}

	accountNum, nextSeq, err = c.querySignerAccountStateAfterFunding(ctx, signer.addressStr)
	if err != nil {
		return fmt.Errorf("query org signer account after funding: %w", err)
	}

	signer.accountNum = accountNum
	signer.nextSeq = nextSeq
	signer.seqLoaded = true
	return nil
}

func (c *GrpcClient) querySignerAccountStateAfterFunding(ctx context.Context, address string) (uint64, uint64, error) {
	var lastErr error

	for attempt := 1; attempt <= accountQueryRetryAttempts; attempt++ {
		accountNum, nextSeq, err := c.querySignerAccountState(ctx, address)
		if err == nil {
			return accountNum, nextSeq, nil
		}

		if !isAccountNotFoundError(err) {
			return 0, 0, err
		}

		lastErr = err
		if attempt == accountQueryRetryAttempts {
			break
		}

		if err := sleepWithContext(ctx, retryBackoff(attempt)); err != nil {
			return 0, 0, err
		}
	}

	return 0, 0, fmt.Errorf("account %s not found after %d retries: %w", address, accountQueryRetryAttempts, lastErr)
}

func (c *GrpcClient) ensureOrgSignerBalance(ctx context.Context, faucetURL string, signer *orgSigner) error {
	balanceRes, err := c.bankQuery.Balance(ctx, &banktypes.QueryBalanceRequest{Address: signer.addressStr, Denom: DefaultFeeDenom})
	if err != nil {
		if !isAccountNotFoundError(err) {
			return fmt.Errorf("query signer balance: %w", err)
		}

		if fundErr := fundFromFaucet(ctx, faucetURL, signer.addressStr, TOPUP_AMOUNT); fundErr != nil {
			return fmt.Errorf("fund signer with missing balance account: %w", fundErr)
		}
		return nil
	}

	if balanceRes == nil || balanceRes.Balance == nil {
		if err := fundFromFaucet(ctx, faucetURL, signer.addressStr, TOPUP_AMOUNT); err != nil {
			return fmt.Errorf("fund signer with empty balance response: %w", err)
		}
		return nil
	}

	if !balanceRes.Balance.Amount.LT(sdkmath.NewInt(MIN_GAS_BALANCE)) {
		return nil
	}

	if err := fundFromFaucet(ctx, faucetURL, signer.addressStr, TOPUP_AMOUNT); err != nil {
		return fmt.Errorf("top up signer balance: %w", err)
	}

	return nil
}

func (c *GrpcClient) querySignerAccountState(ctx context.Context, address string) (uint64, uint64, error) {
	var lastErr error
	for attempt := 1; attempt <= accountQueryRetryAttempts; attempt++ {
		accountRes, err := c.authQuery.Account(ctx, &authtypes.QueryAccountRequest{Address: address})
		if err != nil {
			if isAccountNotFoundError(err) {
				return 0, 0, err
			}
			if !isTransientStoreStateError(err) {
				return 0, 0, fmt.Errorf("query account %s: %w", address, err)
			}

			lastErr = err
			if attempt < accountQueryRetryAttempts {
				time.Sleep(retryBackoff(attempt))
				continue
			}
			break
		}

		var baseAccount authtypes.AccountI
		if unpackErr := c.registry.UnpackAny(accountRes.Account, &baseAccount); unpackErr != nil {
			return 0, 0, fmt.Errorf("unpack account %s: %w", address, unpackErr)
		}

		return baseAccount.GetAccountNumber(), baseAccount.GetSequence(), nil
	}

	if lastErr != nil {
		return 0, 0, fmt.Errorf("query account %s: %w", address, lastErr)
	}
	return 0, 0, fmt.Errorf("query account %s failed", address)
}

func sleepWithContext(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return nil
	}

	timer := time.NewTimer(delay)
	defer timer.Stop()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (c *GrpcClient) broadcastSignedMsgsForOrg(ctx context.Context, signer *orgSigner, mode txBroadcastMode, msgs ...types.Msg) (*types.TxResponse, error) {
	record, err := c.kr.Key(signer.keyringUID)
	if err != nil {
		return nil, fmt.Errorf("get signer key %s: %w", signer.keyringUID, err)
	}

	pubkey, err := record.GetPubKey()
	if err != nil {
		return nil, fmt.Errorf("get pubkey for %s: %w", signer.keyringUID, err)
	}

	signMode := signing.SignMode_SIGN_MODE_DIRECT

	simulationTxBytes, err := c.buildSignedTxBytes(
		ctx,
		msgs,
		pubkey,
		signer.addressStr,
		signer.keyringUID,
		signer.accountNum,
		signer.nextSeq,
		simulateSeedGasLimit,
		signMode,
	)
	if err != nil {
		return nil, err
	}

	simulateCtx, simulateCancel := context.WithTimeout(ctx, BroadcastTimeout)
	simulatedGas, gasLimit, err := c.estimateGasLimit(simulateCtx, c.gasMode, simulationTxBytes)
	simulateCancel()
	if err != nil {
		return nil, err
	}

	switch c.gasMode {
	case gasStrategySimulateBuffer:
		txBytes, err := c.buildSignedTxBytes(ctx, msgs, pubkey, signer.addressStr, signer.keyringUID, signer.accountNum, signer.nextSeq, gasLimit, signMode)
		if err != nil {
			return nil, err
		}

		broadcastCtx, cancel := context.WithTimeout(ctx, BroadcastTimeout)
		defer cancel()

		if mode == txBroadcastModeCommit {
			result, commitErr := c.broadcastTxCommit(broadcastCtx, txBytes)
			if commitErr != nil {
				return nil, fmt.Errorf("broadcast tx commit (strategy=%s simulated_gas=%d gas_limit=%d): %w", c.gasMode, simulatedGas, gasLimit, commitErr)
			}
			if result.Code != 0 {
				return nil, fmt.Errorf("deliver tx failed: codespace %s code %d: %s", result.Codespace, result.Code, result.Log)
			}
			return txResponseFromCommitResult(result), nil
		}

		txHash, syncErr := c.broadcastTxSync(broadcastCtx, txBytes)
		if syncErr != nil {
			return nil, fmt.Errorf("broadcast tx sync (strategy=%s simulated_gas=%d gas_limit=%d): %w", c.gasMode, simulatedGas, gasLimit, syncErr)
		}

		return &types.TxResponse{TxHash: txHash}, nil

	case gasStrategySimulateRetry:
		txHash, attempts, retryErr := runSimulateRetryBroadcast(
			gasLimit,
			maxOutOfGasRetries,
			func(currentGasLimit uint64) (broadcastCommitResult, error) {
				txBytes, buildErr := c.buildSignedTxBytes(ctx, msgs, pubkey, signer.addressStr, signer.keyringUID, signer.accountNum, signer.nextSeq, currentGasLimit, signMode)
				if buildErr != nil {
					return broadcastCommitResult{}, buildErr
				}

				broadcastCtx, cancel := context.WithTimeout(ctx, BroadcastTimeout)
				defer cancel()

				return c.broadcastTxCommit(broadcastCtx, txBytes)
			},
			log.Printf,
		)
		if retryErr != nil {
			return nil, fmt.Errorf(
				"broadcast tx (strategy=%s simulated_gas=%d initial_gas_limit=%d): %w; attempts: %s",
				c.gasMode,
				simulatedGas,
				gasLimit,
				retryErr,
				formatRetryAttempts(attempts),
			)
		}

		if mode == txBroadcastModeCommit {
			latestAttempt := attempts[len(attempts)-1]
			return txResponseFromCommitResult(latestAttempt.DeliverTx), nil
		}

		return &types.TxResponse{TxHash: txHash}, nil

	default:
		return nil, fmt.Errorf("unsupported gas strategy %q", c.gasMode)
	}
}

func txResponseFromCommitResult(result broadcastCommitResult) *types.TxResponse {
	return &types.TxResponse{
		TxHash:    result.TxHash,
		Code:      result.Code,
		Codespace: result.Codespace,
		RawLog:    result.Log,
		GasWanted: int64(result.GasWanted),
		GasUsed:   int64(result.GasUsed),
	}
}

func setMsgSigner(msg types.Msg, signer string) error {
	msgValue := reflect.ValueOf(msg)
	if msgValue.Kind() != reflect.Ptr || msgValue.IsNil() {
		return fmt.Errorf("message %T is not a settable pointer", msg)
	}

	field := msgValue.Elem().FieldByName("Signer")
	if !field.IsValid() || !field.CanSet() || field.Kind() != reflect.String {
		return fmt.Errorf("message %T does not expose mutable Signer field", msg)
	}

	field.SetString(signer)
	return nil
}

func isAccountNotFoundError(err error) bool {
	if err == nil {
		return false
	}
	if status.Code(err) == codes.NotFound {
		return true
	}

	errMsg := strings.ToLower(err.Error())
	return strings.Contains(errMsg, "key not found") || strings.Contains(errMsg, "account not found")
}

func isIncorrectAccountSequenceError(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(strings.ToLower(err.Error()), "incorrect account sequence")
}

func (c *GrpcClient) ExportPrivKey(uid string) (cryptotypes.PrivKey, error) {
	kr, ok := c.kr.(interface {
		ExportPrivateKeyObject(uid string) (cryptotypes.PrivKey, error)
	})
	if !ok {
		return nil, fmt.Errorf("keyring does not support ExportPrivateKeyObject")
	}
	return kr.ExportPrivateKeyObject(uid)
}

func (c *GrpcClient) ExportPrivKeyFromRecord(uid string) (cryptotypes.PrivKey, error) {
	record, err := c.kr.Key(uid)
	if err != nil {
		return nil, fmt.Errorf("key %s: %w", uid, err)
	}

	local := record.GetLocal()
	if local == nil {
		return nil, fmt.Errorf("key %s is not a local key", uid)
	}

	priv, ok := local.PrivKey.GetCachedValue().(cryptotypes.PrivKey)
	if !ok {
		return nil, fmt.Errorf("failed to unpack privkey for %s", uid)
	}

	return priv, nil
}
