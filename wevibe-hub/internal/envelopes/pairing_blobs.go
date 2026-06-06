package envelopes

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

func StorePairingBlob(ctx context.Context, pool *pgxpool.Pool, pairingID, hkdfSalt, iv, ciphertext string) error {
	_, err := pool.Exec(ctx,
		`INSERT INTO pairing_blobs (pairing_id, hkdf_salt, iv, ciphertext)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (pairing_id) DO UPDATE SET
		    hkdf_salt = EXCLUDED.hkdf_salt,
		    iv = EXCLUDED.iv,
		    ciphertext = EXCLUDED.ciphertext,
		    created_at = NOW()`,
		pairingID, hkdfSalt, iv, ciphertext)
	return err
}

func ConsumePairingBlob(ctx context.Context, pool *pgxpool.Pool, pairingID string) (hkdfSalt, iv, ciphertext string, err error) {
	err = pool.QueryRow(ctx,
		`DELETE FROM pairing_blobs
		 WHERE pairing_id = $1
		   AND created_at > NOW() - INTERVAL '15 minutes'
		 RETURNING hkdf_salt, iv, ciphertext`,
		pairingID).Scan(&hkdfSalt, &iv, &ciphertext)

	return hkdfSalt, iv, ciphertext, err
}
