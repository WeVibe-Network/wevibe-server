package envelopes

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Envelope struct {
	OrgID          string  `db:"org_id"`
	Pubkey         string  `db:"pubkey"`
	EncEnvelope    string  `db:"enc_envelope"`
	SearchEnvelope string  `db:"search_envelope"`
	ModEnvelope    *string `db:"mod_envelope"`
}

func Store(ctx context.Context, pool *pgxpool.Pool, orgID, pubkey string, encEnv, searchEnv string, modEnv *string) error {
	_, err := pool.Exec(ctx,
		`INSERT INTO key_envelopes (org_id, pubkey, enc_envelope, search_envelope, mod_envelope)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (org_id, pubkey) DO UPDATE SET
		    enc_envelope = EXCLUDED.enc_envelope,
		    search_envelope = EXCLUDED.search_envelope,
		    mod_envelope = EXCLUDED.mod_envelope,
		    created_at = NOW()`,
		orgID, pubkey, encEnv, searchEnv, modEnv)
	return err
}

func Get(ctx context.Context, pool *pgxpool.Pool, orgID, pubkey string) (*Envelope, error) {
	var env Envelope
	err := pool.QueryRow(ctx,
		`SELECT org_id, pubkey, enc_envelope, search_envelope, mod_envelope
		 FROM key_envelopes
		 WHERE org_id = $1 AND pubkey = $2`,
		orgID, pubkey).Scan(
		&env.OrgID, &env.Pubkey,
		&env.EncEnvelope, &env.SearchEnvelope, &env.ModEnvelope)
	if err != nil {
		return nil, err
	}
	return &env, nil
}

func Delete(ctx context.Context, pool *pgxpool.Pool, orgID, pubkey string) error {
	_, err := pool.Exec(ctx,
		`DELETE FROM key_envelopes WHERE org_id = $1 AND pubkey = $2`,
		orgID, pubkey)
	return err
}
