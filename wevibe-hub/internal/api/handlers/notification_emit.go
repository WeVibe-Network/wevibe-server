package handlers

import (
	"context"
	"time"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/notifications"
)

func emitUserNotification(ctx context.Context, recipientPubkey, category, title, body, eventRef, orgID string) error {
	if pool == nil {
		return nil
	}

	var orgName string
	if orgID != "" {
		_ = pool.QueryRow(ctx, `SELECT org_name FROM orgs WHERE org_id = $1`, orgID).Scan(&orgName)
	}

	var notifID int64
	var createdAt time.Time
	err := pool.QueryRow(ctx, `
		INSERT INTO notifications
			(recipient_pubkey, category, title, body, event_ref, org_id, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, NOW())
		RETURNING id, created_at
	`, recipientPubkey, category, title, body, eventRef, orgID).Scan(&notifID, &createdAt)
	if err != nil {
		return err
	}

	payload := notifications.NotificationPayload{
		ID:        notifID,
		Category:  category,
		Title:     title,
		Body:      body,
		EventRef:  eventRef,
		OrgID:     orgID,
		OrgName:   orgName,
		Read:      false,
		CreatedAt: createdAt.Format(time.RFC3339),
	}

	if notificationHub != nil {
		if data, err := notifications.NewNotificationMessage(&payload); err == nil {
			notificationHub.Broadcast(recipientPubkey, data)
		}
	}

	if notificationDispatcher != nil {
		_ = notificationDispatcher.Dispatch(ctx, notifications.DispatchEvent{
			RecipientPubkey: recipientPubkey,
			Category:        category,
			Title:           title,
			Body:            body,
			EventRef:        eventRef,
			OrgID:           orgID,
			OrgName:         orgName,
			CreatedAt:       createdAt,
		})
	}

	return nil
}
