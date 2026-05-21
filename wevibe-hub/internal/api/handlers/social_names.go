package handlers

import (
	"context"
	"strings"
)

func resolveWalletDisplayNames(ctx context.Context, wallets []string) map[string]string {
	resolved := make(map[string]string, len(wallets))

	cleanWallets := make([]string, 0, len(wallets))
	seen := make(map[string]struct{}, len(wallets))
	for _, wallet := range wallets {
		trimmed := strings.TrimSpace(wallet)
		if trimmed == "" {
			continue
		}
		if _, exists := seen[trimmed]; exists {
			continue
		}
		seen[trimmed] = struct{}{}
		cleanWallets = append(cleanWallets, trimmed)
	}

	if len(cleanWallets) == 0 {
		return resolved
	}

	for _, wallet := range cleanWallets {
		resolved[wallet] = fallbackDisplayName(wallet)
	}

	if socialClient == nil {
		return resolved
	}

	names, err := socialClient.ResolveNames(ctx, cleanWallets)
	if err != nil {
		return resolved
	}

	for wallet, name := range names {
		trimmedName := strings.TrimSpace(name)
		if trimmedName == "" {
			continue
		}
		resolved[wallet] = trimmedName
	}

	return resolved
}

func fallbackDisplayName(wallet string) string {
	trimmed := strings.TrimSpace(wallet)
	if len(trimmed) <= 12 {
		return trimmed
	}
	return trimmed[:6] + "..." + trimmed[len(trimmed)-4:]
}
