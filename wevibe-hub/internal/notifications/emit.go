package notifications

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func EmitUserNotification(ctx context.Context, pool *pgxpool.Pool, hub *NotificationHub, dispatcher *Dispatcher, recipientPubkey, category, title, body, eventRef, orgID string) error {
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

	payload := NotificationPayload{
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

	if hub != nil {
		if data, err := NewNotificationMessage(&payload); err == nil {
			hub.Broadcast(recipientPubkey, data)
		}
	}

	if dispatcher != nil {
		_ = dispatcher.Dispatch(ctx, DispatchEvent{
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
