package handlers

import (
	"context"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/notifications"
)

func emitUserNotification(ctx context.Context, recipientPubkey, category, title, body, eventRef, orgID string) error {
	return notifications.EmitUserNotification(
		ctx,
		pool,
		notificationHub,
		notificationDispatcher,
		recipientPubkey,
		category,
		title,
		body,
		eventRef,
		orgID,
	)
}
