package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/notifications"
)

type NotificationPreferencesResponse struct {
	EmailAddress        string   `json:"email_address"`
	EmailEnabled        bool     `json:"email_enabled"`
	EmailCategories     []string `json:"email_categories"`
	WebhookURL          string   `json:"webhook_url"`
	WebhookEnabled      bool     `json:"webhook_enabled"`
	WebhookCategories   []string `json:"webhook_categories"`
	SupportedCategories []string `json:"supported_categories"`
	TestSent            bool     `json:"test_sent,omitempty"`
}

type UpdateNotificationPreferencesRequest struct {
	EmailAddress      *string   `json:"email_address"`
	EmailEnabled      *bool     `json:"email_enabled"`
	EmailCategories   *[]string `json:"email_categories"`
	WebhookURL        *string   `json:"webhook_url"`
	WebhookEnabled    *bool     `json:"webhook_enabled"`
	WebhookCategories *[]string `json:"webhook_categories"`
	SendTest          bool      `json:"send_test"`
}

func GetNotificationPreferences(w http.ResponseWriter, r *http.Request) {
	signed, err := auth.ParseWeVibeSigned(r)
	if err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	store := notifications.NewPreferenceStore(pool)
	prefs, err := store.Get(r.Context(), signed.Pubkey)
	if err != nil {
		http.Error(w, `{"error":"database error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(NotificationPreferencesResponse{
		EmailAddress:        prefs.EmailAddress,
		EmailEnabled:        prefs.EmailEnabled,
		EmailCategories:     prefs.EmailCategories,
		WebhookURL:          prefs.WebhookURL,
		WebhookEnabled:      prefs.WebhookEnabled,
		WebhookCategories:   prefs.WebhookCategories,
		SupportedCategories: notifications.SupportedCategories(),
	})
}

func UpdateNotificationPreferences(w http.ResponseWriter, r *http.Request) {
	signed, err := auth.ParseWeVibeSigned(r)
	if err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	var req UpdateNotificationPreferencesRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	store := notifications.NewPreferenceStore(pool)
	prefs, err := store.Update(r.Context(), signed.Pubkey, notifications.PreferencePatch{
		EmailAddress:      req.EmailAddress,
		EmailEnabled:      req.EmailEnabled,
		EmailCategories:   req.EmailCategories,
		WebhookURL:        req.WebhookURL,
		WebhookEnabled:    req.WebhookEnabled,
		WebhookCategories: req.WebhookCategories,
	})
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusBadRequest)
		return
	}

	testSent := false
	if req.SendTest {
		testSent = emitUserNotification(
			r.Context(),
			signed.Pubkey,
			"test_notification",
			"Test notification",
			"This is a test notification from your profile settings.",
			"profile-notification-test",
			"",
		) == nil
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(NotificationPreferencesResponse{
		EmailAddress:        prefs.EmailAddress,
		EmailEnabled:        prefs.EmailEnabled,
		EmailCategories:     prefs.EmailCategories,
		WebhookURL:          prefs.WebhookURL,
		WebhookEnabled:      prefs.WebhookEnabled,
		WebhookCategories:   prefs.WebhookCategories,
		SupportedCategories: notifications.SupportedCategories(),
		TestSent:            testSent,
	})
}
