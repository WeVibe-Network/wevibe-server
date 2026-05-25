-- Migration: 000003_delegate_keys_wallet_pk.up.sql
-- Overhaul of delegate_keys schema per Decision H (CO-011a.4)
-- Drops org_id column, changes PK to wallet_address, adds UNIQUE on delegate_address
-- Pre-MVP DB wipe is acceptable per R-NO-DB-HACKS

DROP TABLE IF EXISTS delegate_keys;

CREATE TABLE delegate_keys (
    wallet_address      TEXT PRIMARY KEY,
    delegate_address    TEXT UNIQUE NOT NULL,
    delegate_pubkey     TEXT NOT NULL,
    grant_tx_hash       TEXT,
    grant_expiration    TIMESTAMPTZ,
    active              BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_delegate_keys_delegate_address ON delegate_keys(delegate_address);