package chain

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	cryptotypes "github.com/cosmos/cosmos-sdk/crypto/types"
	"github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/types/tx/signing"
	authsigning "github.com/cosmos/cosmos-sdk/x/auth/signing"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
)

const (
	DefaultGasPerMsg = uint64(200_000)
	DefaultFeeDenom  = "uvibe"
	DefaultFeeAmount = int64(2000)
	BroadcastTimeout = 30 * time.Second
	retryAttempts    = 8
	minGasPriceNum   = int64(25)
	minGasPriceDen   = int64(1000)
)

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

type rpcGenesisResponse struct {
	Result struct {
		Genesis struct {
			AppState struct {
				Auth struct {
					Accounts []struct {
						Address       string `json:"address"`
						AccountNumber string `json:"account_number"`
						Sequence      string `json:"sequence"`
					} `json:"accounts"`
				} `json:"auth"`
			} `json:"app_state"`
		} `json:"genesis"`
	} `json:"result"`
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

func (c *GrpcClient) loadFallbackSignerState(ctx context.Context) (uint64, uint64, error) {
	c.fallbackMu.Lock()
	if c.fallbackStateLoaded {
		accNum := c.fallbackAccountNumber
		accSeq := c.fallbackSequence
		c.fallbackMu.Unlock()
		return accNum, accSeq, nil
	}
	c.fallbackMu.Unlock()

	if c.rpcURL == "" {
		return 0, 0, fmt.Errorf("WEVIBE_CHAIN_RPC_URL is required for fallback signer state")
	}

	genesisURL := strings.TrimRight(c.rpcURL, "/") + "/genesis"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, genesisURL, nil)
	if err != nil {
		return 0, 0, fmt.Errorf("build genesis request: %w", err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, 0, fmt.Errorf("fetch genesis: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return 0, 0, fmt.Errorf("fetch genesis: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, 0, fmt.Errorf("read genesis response: %w", err)
	}

	var parsed rpcGenesisResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return 0, 0, fmt.Errorf("decode genesis response: %w", err)
	}

	for _, account := range parsed.Result.Genesis.AppState.Auth.Accounts {
		if account.Address != c.submitter.String() {
			continue
		}

		accNum, err := strconv.ParseUint(account.AccountNumber, 10, 64)
		if err != nil {
			return 0, 0, fmt.Errorf("parse fallback account_number: %w", err)
		}
		accSeq, err := strconv.ParseUint(account.Sequence, 10, 64)
		if err != nil {
			return 0, 0, fmt.Errorf("parse fallback sequence: %w", err)
		}

		c.fallbackMu.Lock()
		c.fallbackAccountNumber = accNum
		c.fallbackSequence = accSeq
		c.fallbackStateLoaded = true
		c.fallbackMu.Unlock()

		return accNum, accSeq, nil
	}

	return 0, 0, fmt.Errorf("submitter account %s not found in genesis", c.submitter.String())
}

func (c *GrpcClient) BroadcastMsgs(ctx context.Context, msgs ...types.Msg) (string, error) {
	if len(msgs) == 0 {
		return "", fmt.Errorf("no messages to broadcast")
	}

	var (
		accNum uint64
		accSeq uint64
		err    error
	)

	for attempt := 1; attempt <= retryAttempts; attempt++ {
		var accountRes *authtypes.QueryAccountResponse
		accountRes, err = c.authQuery.Account(ctx, &authtypes.QueryAccountRequest{Address: c.submitter.String()})
		if err == nil {
			var baseAccount authtypes.AccountI
			if unpackErr := c.registry.UnpackAny(accountRes.Account, &baseAccount); unpackErr != nil {
				return "", fmt.Errorf("unpack account: %w", unpackErr)
			}

			accNum = baseAccount.GetAccountNumber()
			accSeq = baseAccount.GetSequence()

			c.fallbackMu.Lock()
			c.fallbackAccountNumber = accNum
			c.fallbackSequence = accSeq
			c.fallbackStateLoaded = true
			c.fallbackMu.Unlock()

			break
		}

		if !isTransientStoreStateError(err) {
			return "", fmt.Errorf("query account: %w", err)
		}

		if attempt == retryAttempts {
			accNum, accSeq, err = c.loadFallbackSignerState(ctx)
			if err != nil {
				return "", fmt.Errorf("query account: %w", err)
			}
			break
		}

		time.Sleep(retryBackoff(attempt))
	}

	txBuilder := c.txConfig.NewTxBuilder()

	gasLimit := DefaultGasPerMsg * uint64(len(msgs))
	feeAmount := (int64(gasLimit) * minGasPriceNum) / minGasPriceDen
	if (int64(gasLimit)*minGasPriceNum)%minGasPriceDen != 0 {
		feeAmount++
	}
	if feeAmount < DefaultFeeAmount {
		feeAmount = DefaultFeeAmount
	}
	fee := types.NewCoins(types.NewInt64Coin(DefaultFeeDenom, feeAmount))

	txBuilder.SetGasLimit(gasLimit)
	txBuilder.SetFeeAmount(fee)
	txBuilder.SetMsgs(msgs...)

	record, err := c.kr.Key("submitter")
	if err != nil {
		return "", fmt.Errorf("get submitter key: %w", err)
	}

	pubkey, err := record.GetPubKey()
	if err != nil {
		return "", fmt.Errorf("get pubkey: %w", err)
	}

	signMode := signing.SignMode_SIGN_MODE_DIRECT

	emptySig := signing.SignatureV2{
		PubKey: pubkey,
		Data: &signing.SingleSignatureData{
			SignMode:  signMode,
			Signature: nil,
		},
		Sequence: accSeq,
	}

	if err := txBuilder.SetSignatures(emptySig); err != nil {
		return "", fmt.Errorf("set empty signatures: %w", err)
	}

	signerData := authsigning.SignerData{
		Address:       c.submitter.String(),
		ChainID:       c.chainID,
		AccountNumber: accNum,
		Sequence:      accSeq,
		PubKey:        pubkey,
	}

	signBytes, err := authsigning.GetSignBytesAdapter(
		ctx, c.txConfig.SignModeHandler(), signMode, signerData, txBuilder.GetTx(),
	)
	if err != nil {
		return "", fmt.Errorf("get sign bytes: %w", err)
	}

	sigBytes, _, err := c.kr.Sign("submitter", signBytes, signMode)
	if err != nil {
		return "", fmt.Errorf("sign: %w", err)
	}

	sigV2WithSig := signing.SignatureV2{
		PubKey: pubkey,
		Data: &signing.SingleSignatureData{
			SignMode:  signMode,
			Signature: sigBytes,
		},
		Sequence: accSeq,
	}

	if err := txBuilder.SetSignatures(sigV2WithSig); err != nil {
		return "", fmt.Errorf("set signatures: %w", err)
	}

	txBytes, err := c.txConfig.TxEncoder()(txBuilder.GetTx())
	if err != nil {
		return "", fmt.Errorf("encode tx: %w", err)
	}

	broadcastCtx, cancel := context.WithTimeout(ctx, BroadcastTimeout)
	defer cancel()

	for attempt := 1; attempt <= retryAttempts; attempt++ {
		txHash, broadcastErr := c.broadcastTxSync(broadcastCtx, txBytes)
		if broadcastErr != nil {
			if attempt < retryAttempts && isTransientStoreStateError(broadcastErr) {
				time.Sleep(retryBackoff(attempt))
				continue
			}
			return "", fmt.Errorf("broadcast tx: %w", broadcastErr)
		}

		c.fallbackMu.Lock()
		c.fallbackAccountNumber = accNum
		c.fallbackSequence = accSeq + 1
		c.fallbackStateLoaded = true
		c.fallbackMu.Unlock()

		return txHash, nil
	}

	return "", fmt.Errorf("broadcast tx: exceeded retry attempts")
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
