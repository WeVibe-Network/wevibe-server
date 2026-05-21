package social

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Profile struct {
	Wallet      string  `json:"wallet"`
	DisplayName string  `json:"display_name"`
	AvatarURL   *string `json:"avatar_url,omitempty"`
	CreatedAt   string  `json:"created_at"`
	UpdatedAt   string  `json:"updated_at"`
}

type Client struct {
	baseURL    string
	httpClient *http.Client
}

func NewClient(baseURL string) *Client {
	trimmed := strings.TrimSpace(baseURL)
	if trimmed == "" {
		return nil
	}
	return &Client{
		baseURL: strings.TrimRight(trimmed, "/"),
		httpClient: &http.Client{
			Timeout: 5 * time.Second,
		},
	}
}

func (c *Client) ResolveNames(ctx context.Context, wallets []string) (map[string]string, error) {
	if c == nil {
		return nil, fmt.Errorf("social graph client not configured")
	}

	cleanWallets := dedupeWallets(wallets)
	if len(cleanWallets) == 0 {
		return map[string]string{}, nil
	}

	requestURL := fmt.Sprintf("%s/v1/profiles/batch?wallets=%s", c.baseURL, url.QueryEscape(strings.Join(cleanWallets, ",")))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("social graph batch lookup failed: status %d", resp.StatusCode)
	}

	profiles := []Profile{}
	if err := json.NewDecoder(resp.Body).Decode(&profiles); err != nil {
		return nil, err
	}

	resolved := make(map[string]string, len(profiles))
	for _, profile := range profiles {
		wallet := strings.TrimSpace(profile.Wallet)
		name := strings.TrimSpace(profile.DisplayName)
		if wallet == "" || name == "" {
			continue
		}
		resolved[wallet] = name
	}

	return resolved, nil
}

func (c *Client) GetProfile(ctx context.Context, wallet string) (*Profile, error) {
	if c == nil {
		return nil, fmt.Errorf("social graph client not configured")
	}
	wallet = strings.TrimSpace(wallet)
	if wallet == "" {
		return nil, fmt.Errorf("wallet is required")
	}

	requestURL := fmt.Sprintf("%s/v1/profiles/%s", c.baseURL, url.PathEscape(wallet))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("social graph profile lookup failed: status %d", resp.StatusCode)
	}

	var profile Profile
	if err := json.NewDecoder(resp.Body).Decode(&profile); err != nil {
		return nil, err
	}

	return &profile, nil
}

func dedupeWallets(wallets []string) []string {
	seen := make(map[string]struct{}, len(wallets))
	unique := make([]string, 0, len(wallets))
	for _, wallet := range wallets {
		trimmed := strings.TrimSpace(wallet)
		if trimmed == "" {
			continue
		}
		if _, exists := seen[trimmed]; exists {
			continue
		}
		seen[trimmed] = struct{}{}
		unique = append(unique, trimmed)
	}
	return unique
}
