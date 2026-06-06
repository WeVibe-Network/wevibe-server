package envelopes

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

func StoreIdentityBlob(ctx context.Context, pool *pgxpool.Pool, pubkey, credentialID, hkdfSalt, iv, ciphertext string) error {
	_, err := pool.Exec(ctx,
		`INSERT INTO identity_blobs (pubkey, credential_id, hkdf_salt, iv, ciphertext)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (pubkey, credential_id) DO UPDATE SET
		    hkdf_salt = EXCLUDED.hkdf_salt,
		    iv = EXCLUDED.iv,
		    ciphertext = EXCLUDED.ciphertext,
		    created_at = NOW()`,
		pubkey, credentialID, hkdfSalt, iv, ciphertext)
	return err
}

func GetIdentityBlob(ctx context.Context, pool *pgxpool.Pool, credentialID string) (pubkey, hkdfSalt, iv, ciphertext string, err error) {
	err = pool.QueryRow(ctx,
		`SELECT pubkey, hkdf_salt, iv, ciphertext
		 FROM identity_blobs
		 WHERE credential_id = $1
		 LIMIT 1`,
		credentialID).Scan(&pubkey, &hkdfSalt, &iv, &ciphertext)

	return pubkey, hkdfSalt, iv, ciphertext, err
}
