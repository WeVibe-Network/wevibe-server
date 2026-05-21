package notifications

import (
	"context"
	"errors"
	"log/slog"
	"time"
)

type DispatchEvent struct {
	RecipientPubkey string
	Category        string
	Title           string
	Body            string
	EventRef        string
	OrgID           string
	OrgName         string
	CreatedAt       time.Time
}

type NotificationChannel interface {
	Name() string
	Dispatch(ctx context.Context, prefs UserPreferences, event DispatchEvent) error
}

type Dispatcher struct {
	store    *PreferenceStore
	logger   *slog.Logger
	channels map[string]NotificationChannel
}

func NewDispatcher(store *PreferenceStore, logger *slog.Logger) *Dispatcher {
	if logger == nil {
		logger = slog.Default()
	}
	return &Dispatcher{
		store:    store,
		logger:   logger,
		channels: make(map[string]NotificationChannel),
	}
}

func (d *Dispatcher) Register(channel NotificationChannel) {
	if d == nil || channel == nil {
		return
	}
	d.channels[channel.Name()] = channel
}

func (d *Dispatcher) Dispatch(ctx context.Context, event DispatchEvent) error {
	if d == nil || d.store == nil || event.RecipientPubkey == "" {
		return nil
	}

	prefs, err := d.store.Get(ctx, event.RecipientPubkey)
	if err != nil {
		return err
	}

	var dispatchErr error
	for name, channel := range d.channels {
		if !shouldDispatch(name, prefs, event.Category) {
			continue
		}
		if err := channel.Dispatch(ctx, prefs, event); err != nil {
			d.logger.Error("notification channel dispatch failed",
				"channel", name,
				"recipient", event.RecipientPubkey,
				"category", event.Category,
				"err", err,
			)
			dispatchErr = errors.Join(dispatchErr, err)
		}
	}

	return dispatchErr
}

func shouldDispatch(channelName string, prefs UserPreferences, category string) bool {
	switch channelName {
	case "email":
		if !prefs.EmailEnabled || prefs.EmailAddress == "" {
			return false
		}
		return IsCategoryEnabled(prefs.EmailCategories, category)
	case "webhook":
		if !prefs.WebhookEnabled || prefs.WebhookURL == "" {
			return false
		}
		return IsCategoryEnabled(prefs.WebhookCategories, category)
	case "push":
		return false
	default:
		return false
	}
}
