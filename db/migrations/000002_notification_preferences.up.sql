CREATE TABLE IF NOT EXISTS notification_preferences (
    recipient_pubkey    TEXT        PRIMARY KEY,
    email_address       TEXT        NOT NULL DEFAULT '',
    email_enabled       BOOLEAN     NOT NULL DEFAULT FALSE,
    email_categories    TEXT[]      NOT NULL DEFAULT '{}',
    webhook_url         TEXT        NOT NULL DEFAULT '',
    webhook_enabled     BOOLEAN     NOT NULL DEFAULT FALSE,
    webhook_categories  TEXT[]      NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_preferences_updated_at
    ON notification_preferences(updated_at DESC);
