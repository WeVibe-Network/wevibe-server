package envelopes

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
)

type Envelope struct {
	OrgID          string  `db:"org_id"`
	Pubkey         string  `db:"pubkey"`
	EpochID        int     `db:"epoch_id"`
	EncEnvelope    string  `db:"enc_envelope"`
	SearchEnvelope string  `db:"search_envelope"`
	ModEnvelope    *string `db:"mod_envelope"`
}

func Store(ctx context.Context, pool *pgxpool.Pool, orgID, pubkey string, epochID int, encEnv, searchEnv string, modEnv *string) error {
	_, err := pool.Exec(ctx,
		`INSERT INTO key_envelopes (org_id, pubkey, epoch_id, enc_envelope, search_envelope, mod_envelope)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (org_id, pubkey) DO UPDATE SET
		    epoch_id = EXCLUDED.epoch_id,
		    enc_envelope = EXCLUDED.enc_envelope,
		    search_envelope = EXCLUDED.search_envelope,
		    mod_envelope = EXCLUDED.mod_envelope,
		    created_at = NOW()`,
		orgID, pubkey, epochID, encEnv, searchEnv, modEnv)
	return err
}

func Get(ctx context.Context, pool *pgxpool.Pool, orgID, pubkey string) (*Envelope, error) {
	var env Envelope
	err := pool.QueryRow(ctx,
		`SELECT org_id, pubkey, epoch_id, enc_envelope, search_envelope, mod_envelope
		 FROM key_envelopes
		 WHERE org_id = $1 AND pubkey = $2`,
		orgID, pubkey).Scan(
		&env.OrgID, &env.Pubkey, &env.EpochID,
		&env.EncEnvelope, &env.SearchEnvelope, &env.ModEnvelope)
	if err != nil {
		return nil, err
	}
	return &env, nil
}

func BatchReplace(ctx context.Context, pool *pgxpool.Pool, orgID string, epochID int, pairs []protocol.MemberEnvelopePair) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `DELETE FROM key_envelopes WHERE org_id = $1`, orgID); err != nil {
		return err
	}

	for _, p := range pairs {
		if _, err := tx.Exec(ctx,
			`INSERT INTO key_envelopes (org_id, pubkey, epoch_id, enc_envelope, search_envelope, mod_envelope)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			orgID, p.Pubkey, epochID, p.EncEnvelope, p.SearchEnvelope, p.ModEnvelope); err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

func Delete(ctx context.Context, pool *pgxpool.Pool, orgID, pubkey string) error {
	_, err := pool.Exec(ctx,
		`DELETE FROM key_envelopes WHERE org_id = $1 AND pubkey = $2`,
		orgID, pubkey)
	return err
}
