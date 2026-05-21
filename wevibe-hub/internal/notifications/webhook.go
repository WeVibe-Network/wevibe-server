package notifications

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

type WebhookChannel struct {
	client *http.Client
}

type webhookPayload struct {
	Category  string `json:"category"`
	Title     string `json:"title"`
	Body      string `json:"body"`
	EventRef  string `json:"event_ref"`
	OrgID     string `json:"org_id"`
	OrgName   string `json:"org_name"`
	CreatedAt string `json:"created_at"`
}

func NewWebhookChannel() *WebhookChannel {
	return &WebhookChannel{
		client: &http.Client{Timeout: 5 * time.Second},
	}
}

func (w *WebhookChannel) Name() string {
	return "webhook"
}

func (w *WebhookChannel) Dispatch(ctx context.Context, prefs UserPreferences, event DispatchEvent) error {
	payload := webhookPayload{
		Category:  event.Category,
		Title:     event.Title,
		Body:      event.Body,
		EventRef:  event.EventRef,
		OrgID:     event.OrgID,
		OrgName:   event.OrgName,
		CreatedAt: event.CreatedAt.UTC().Format(time.RFC3339),
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, prefs.WebhookURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := w.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("webhook returned status %d", resp.StatusCode)
	}

	return nil
}
