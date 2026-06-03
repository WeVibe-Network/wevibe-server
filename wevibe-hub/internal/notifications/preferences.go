package notifications

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var supportedCategories = []string{
	"join_request_received",
	"join_approved",
	"join_denied",
	"contributor_promoted",
	"contributor_revoked",
	"test_notification",
}

func SupportedCategories() []string {
	out := make([]string, len(supportedCategories))
	copy(out, supportedCategories)
	return out
}

type UserPreferences struct {
	RecipientPubkey   string
	EmailAddress      string
	EmailEnabled      bool
	EmailCategories   []string
	WebhookURL        string
	WebhookEnabled    bool
	WebhookCategories []string
}

type PreferencePatch struct {
	EmailAddress      *string
	EmailEnabled      *bool
	EmailCategories   *[]string
	WebhookURL        *string
	WebhookEnabled    *bool
	WebhookCategories *[]string
}

type PreferenceStore struct {
	pool *pgxpool.Pool
}

func NewPreferenceStore(pool *pgxpool.Pool) *PreferenceStore {
	return &PreferenceStore{pool: pool}
}

func DefaultUserPreferences(pubkey string) UserPreferences {
	defaultCategories := SupportedCategories()
	return UserPreferences{
		RecipientPubkey:   pubkey,
		EmailCategories:   defaultCategories,
		WebhookCategories: defaultCategories,
	}
}

func (s *PreferenceStore) Get(ctx context.Context, pubkey string) (UserPreferences, error) {
	if s == nil || s.pool == nil {
		return UserPreferences{}, fmt.Errorf("preference store unavailable")
	}

	prefs := DefaultUserPreferences(pubkey)
	err := s.pool.QueryRow(ctx, `
		SELECT
			COALESCE(email_address, ''),
			email_enabled,
			COALESCE(email_categories, '{}'::TEXT[]),
			COALESCE(webhook_url, ''),
			webhook_enabled,
			COALESCE(webhook_categories, '{}'::TEXT[])
		FROM notification_preferences
		WHERE recipient_pubkey = $1
	`, pubkey).Scan(
		&prefs.EmailAddress,
		&prefs.EmailEnabled,
		&prefs.EmailCategories,
		&prefs.WebhookURL,
		&prefs.WebhookEnabled,
		&prefs.WebhookCategories,
	)
	if err == pgx.ErrNoRows {
		return prefs, nil
	}
	if err != nil {
		return UserPreferences{}, err
	}

	prefs.EmailCategories = filterKnownCategories(prefs.EmailCategories)
	prefs.WebhookCategories = filterKnownCategories(prefs.WebhookCategories)
	return prefs, nil
}

func (s *PreferenceStore) Update(ctx context.Context, pubkey string, patch PreferencePatch) (UserPreferences, error) {
	current, err := s.Get(ctx, pubkey)
	if err != nil {
		return UserPreferences{}, err
	}

	if patch.EmailAddress != nil {
		current.EmailAddress = strings.TrimSpace(*patch.EmailAddress)
	}
	if patch.EmailEnabled != nil {
		current.EmailEnabled = *patch.EmailEnabled
	}
	if patch.EmailCategories != nil {
		validated, err := canonicalizeCategoryList(*patch.EmailCategories)
		if err != nil {
			return UserPreferences{}, err
		}
		current.EmailCategories = validated
	}
	if patch.WebhookURL != nil {
		current.WebhookURL = strings.TrimSpace(*patch.WebhookURL)
	}
	if patch.WebhookEnabled != nil {
		current.WebhookEnabled = *patch.WebhookEnabled
	}
	if patch.WebhookCategories != nil {
		validated, err := canonicalizeCategoryList(*patch.WebhookCategories)
		if err != nil {
			return UserPreferences{}, err
		}
		current.WebhookCategories = validated
	}

	if current.WebhookURL != "" {
		if err := validateWebhookURL(current.WebhookURL); err != nil {
			return UserPreferences{}, err
		}
	}

	_, err = s.pool.Exec(ctx, `
		INSERT INTO notification_preferences (
			recipient_pubkey,
			email_address,
			email_enabled,
			email_categories,
			webhook_url,
			webhook_enabled,
			webhook_categories,
			updated_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
		ON CONFLICT (recipient_pubkey)
		DO UPDATE SET
			email_address = EXCLUDED.email_address,
			email_enabled = EXCLUDED.email_enabled,
			email_categories = EXCLUDED.email_categories,
			webhook_url = EXCLUDED.webhook_url,
			webhook_enabled = EXCLUDED.webhook_enabled,
			webhook_categories = EXCLUDED.webhook_categories,
			updated_at = NOW()
	`,
		pubkey,
		current.EmailAddress,
		current.EmailEnabled,
		current.EmailCategories,
		current.WebhookURL,
		current.WebhookEnabled,
		current.WebhookCategories,
	)
	if err != nil {
		return UserPreferences{}, err
	}

	return current, nil
}

func ParseCategoryToggles(categories []string) (map[string]bool, error) {
	toggles := make(map[string]bool, len(supportedCategories))
	for _, category := range supportedCategories {
		toggles[category] = false
	}

	for _, category := range categories {
		normalized := strings.TrimSpace(category)
		if normalized == "" {
			continue
		}
		if _, ok := toggles[normalized]; !ok {
			return nil, fmt.Errorf("unsupported notification category: %s", normalized)
		}
		toggles[normalized] = true
	}

	return toggles, nil
}

func IsCategoryEnabled(categories []string, category string) bool {
	toggles, err := ParseCategoryToggles(categories)
	if err != nil {
		return false
	}
	return toggles[category]
}

func canonicalizeCategoryList(categories []string) ([]string, error) {
	toggles, err := ParseCategoryToggles(categories)
	if err != nil {
		return nil, err
	}

	normalized := make([]string, 0, len(supportedCategories))
	for _, category := range supportedCategories {
		if toggles[category] {
			normalized = append(normalized, category)
		}
	}
	return normalized, nil
}

func filterKnownCategories(categories []string) []string {
	normalized, err := canonicalizeCategoryList(categories)
	if err != nil {
		return SupportedCategories()
	}
	return normalized
}

func validateWebhookURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid webhook_url")
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return fmt.Errorf("webhook_url must use http or https")
	}
	if parsed.Host == "" {
		return fmt.Errorf("invalid webhook_url")
	}
	return nil
}
