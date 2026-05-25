-- Migration: 000003_delegate_keys_wallet_pk.down.sql
-- Pre-MVP wipe is acceptable per R-NO-DB-HACKS
-- This down migration drops the table entirely

DROP TABLE IF EXISTS delegate_keys;