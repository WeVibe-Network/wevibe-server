package chain

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

func fundFromFaucet(ctx context.Context, faucetURL, address string, amount int64) error {
	trimmedURL := strings.TrimSpace(faucetURL)
	if trimmedURL == "" {
		return fmt.Errorf("faucetURL is required")
	}
	if strings.TrimSpace(address) == "" {
		return fmt.Errorf("address is required")
	}
	if amount <= 0 {
		return fmt.Errorf("amount must be positive")
	}

	body, err := json.Marshal(map[string]any{
		"address": address,
		"amount":  amount,
	})
	if err != nil {
		return fmt.Errorf("marshal faucet request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(trimmedURL, "/")+"/v1/fund", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build faucet request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("faucet request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, readErr := io.ReadAll(io.LimitReader(resp.Body, 4096))
		if readErr != nil {
			return fmt.Errorf("faucet status %d and failed reading body: %w", resp.StatusCode, readErr)
		}
		return fmt.Errorf("faucet status %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}

	return nil
}

func (c *GrpcClient) FundAddressFromFaucet(ctx context.Context, faucetURL, address string, amount int64) error {
	return fundFromFaucet(ctx, faucetURL, address, amount)
}
