package memories

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/chain"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/wlog"
)

var (
	ErrMemoryNotApproved      = errors.New("memory_not_approved")
	ErrMemoryCheckUnavailable = errors.New("memory_check_unavailable")
)

var getMemoriesBatch = func(ctx context.Context, chainClient *chain.GrpcClient, orgID string, hashes [][]byte) (int, int, error) {
	if chainClient == nil {
		return 0, 0, fmt.Errorf("chain client unavailable")
	}
	results, notFound, err := chainClient.GetMemoriesBatch(ctx, orgID, hashes)
	return len(results), len(notFound), err
}

// EnsureApproved is the hub's single admission authority for memory-backed
// serve/outcome intake. It accepts only memories that are already approved on
// chain, or committed in the hub DB while awaiting chain batch visibility.
func EnsureApproved(ctx context.Context, pool *pgxpool.Pool, chainClient *chain.GrpcClient, orgID, memoryHashHex string) error {
	memoryHash, err := hex.DecodeString(memoryHashHex)
	if err != nil || len(memoryHash) != 32 {
		return fmt.Errorf("memory hash must be 32-byte hex before approval check")
	}

	orgFP := wlog.Fingerprint([]byte(orgID))
	memoryHash8 := first8(memoryHashHex)

	resultCount, _, chainErr := getMemoriesBatch(ctx, chainClient, orgID, [][]byte{memoryHash})
	if chainErr == nil && resultCount > 0 {
		wlog.Op(ctx, "hub.memory_approval", slog.LevelInfo,
			slog.String("status", "approved"),
			slog.String("source", "chain"),
			slog.String("org_fp", orgFP),
			slog.String("memory_hash", memoryHash8))
		return nil
	}

	if pool == nil {
		dbErr := fmt.Errorf("database pool unavailable")
		if chainErr != nil {
			return memoryCheckUnavailable(ctx, orgFP, memoryHash8, chainErr, dbErr)
		}
		return memoryCheckUnavailable(ctx, orgFP, memoryHash8, fmt.Errorf("chain returned no approved memory"), dbErr)
	}

	var exists int
	dbErr := pool.QueryRow(ctx, `
		SELECT 1
		FROM pending_submissions
		WHERE submission_hash = $1 AND org_id = $2 AND status = $3
	`, memoryHashHex, orgID, protocol.SubmissionStatusCommitted).Scan(&exists)
	if dbErr == nil {
		wlog.Op(ctx, "hub.memory_approval", slog.LevelInfo,
			slog.String("status", "approved"),
			slog.String("source", "db"),
			slog.String("org_fp", orgFP),
			slog.String("memory_hash", memoryHash8))
		return nil
	}
	if !errors.Is(dbErr, pgx.ErrNoRows) {
		if chainErr != nil {
			return memoryCheckUnavailable(ctx, orgFP, memoryHash8, chainErr, dbErr)
		}
		return memoryCheckUnavailable(ctx, orgFP, memoryHash8, fmt.Errorf("chain returned no approved memory"), dbErr)
	}
	if chainErr != nil {
		return memoryCheckUnavailable(ctx, orgFP, memoryHash8, chainErr, dbErr)
	}
	attrs := []slog.Attr{
		slog.String("status", "not_approved"),
		slog.String("org_fp", orgFP),
		slog.String("memory_hash", memoryHash8),
	}
	if chainErr != nil {
		attrs = append(attrs, slog.String("chain_err", chainErr.Error()))
	}
	wlog.Op(ctx, "hub.memory_approval", slog.LevelError, attrs...)
	return fmt.Errorf("%w: org=%s memory_hash=%s", ErrMemoryNotApproved, orgFP, memoryHash8)
}

func memoryCheckUnavailable(ctx context.Context, orgFP, memoryHash8 string, chainErr, dbErr error) error {
	wlog.Op(ctx, "hub.memory_approval", slog.LevelError,
		slog.String("status", "check_unavailable"),
		slog.String("org_fp", orgFP),
		slog.String("memory_hash", memoryHash8),
		slog.String("chain_err", chainErr.Error()),
		slog.String("db_err", dbErr.Error()))
	return fmt.Errorf("%w: chain: %v; db: %v", ErrMemoryCheckUnavailable, chainErr, dbErr)
}

func first8(value string) string {
	if len(value) <= 8 {
		return value
	}
	return value[:8]
}
