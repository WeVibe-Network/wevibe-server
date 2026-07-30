package memories

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/chain"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/db"
)

func TestEnsureApproved_ApprovedOnChainAdmitted(t *testing.T) {
	restore := stubGetMemoriesBatch(func(context.Context, string, [][]byte) (int, int, error) {
		return 1, 0, nil
	})
	defer restore()

	if err := EnsureApproved(context.Background(), nil, nil, "org-chain", strings.Repeat("a", 64)); err != nil {
		t.Fatalf("EnsureApproved returned error: %v", err)
	}
}

func TestEnsureApproved_ApprovedInDBOnlyAdmitted(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := fmt.Sprintf("test-org-memory-approval-%d", time.Now().UnixNano())
	seedOrg(t, pool, orgID)
	memoryHash := strings.Repeat("b", 64)
	seedCommittedSubmission(t, pool, orgID, memoryHash)

	restore := stubGetMemoriesBatch(func(context.Context, string, [][]byte) (int, int, error) {
		return 0, 1, nil
	})
	defer restore()

	if err := EnsureApproved(ctx, pool, nil, orgID, memoryHash); err != nil {
		t.Fatalf("EnsureApproved returned error: %v", err)
	}
}

func TestEnsureApproved_UnknownHashReturnsMemoryNotApproved(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := fmt.Sprintf("test-org-memory-unknown-%d", time.Now().UnixNano())
	seedOrg(t, pool, orgID)

	restore := stubGetMemoriesBatch(func(context.Context, string, [][]byte) (int, int, error) {
		return 0, 1, nil
	})
	defer restore()

	err := EnsureApproved(ctx, pool, nil, orgID, strings.Repeat("c", 64))
	if !errors.Is(err, ErrMemoryNotApproved) {
		t.Fatalf("EnsureApproved error = %v, want ErrMemoryNotApproved", err)
	}
}

func TestEnsureApproved_BothSourcesErrorReturnsMemoryCheckUnavailable(t *testing.T) {
	restore := stubGetMemoriesBatch(func(context.Context, string, [][]byte) (int, int, error) {
		return 0, 0, errors.New("chain down")
	})
	defer restore()

	err := EnsureApproved(context.Background(), nil, nil, "org-error", strings.Repeat("d", 64))
	if !errors.Is(err, ErrMemoryCheckUnavailable) {
		t.Fatalf("EnsureApproved error = %v, want ErrMemoryCheckUnavailable", err)
	}
}

func TestEnsureApproved_ChainErrorWithNoDBRowReturnsCheckUnavailable(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := fmt.Sprintf("test-org-memory-chain-error-no-row-%d", time.Now().UnixNano())
	seedOrg(t, pool, orgID)

	restore := stubGetMemoriesBatch(func(context.Context, string, [][]byte) (int, int, error) {
		return 0, 0, errors.New("chain down")
	})
	defer restore()

	err := EnsureApproved(ctx, pool, nil, orgID, strings.Repeat("e", 64))
	if !errors.Is(err, ErrMemoryCheckUnavailable) {
		t.Fatalf("EnsureApproved error = %v, want ErrMemoryCheckUnavailable", err)
	}
	if errors.Is(err, ErrMemoryNotApproved) {
		t.Fatalf("EnsureApproved error = %v, must not be ErrMemoryNotApproved", err)
	}
}

func stubGetMemoriesBatch(fn func(context.Context, string, [][]byte) (int, int, error)) func() {
	original := getMemoriesBatch
	getMemoriesBatch = func(ctx context.Context, _ *chain.GrpcClient, orgID string, hashes [][]byte) (int, int, error) {
		return fn(ctx, orgID, hashes)
	}
	return func() { getMemoriesBatch = original }
}

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	connStr := os.Getenv("DATABASE_URL")
	if connStr == "" {
		t.Skip("DATABASE_URL not set — skipping DB test")
	}
	pool, err := db.NewPool(context.Background(), connStr)
	if err != nil {
		t.Skipf("database unavailable: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedOrg(t *testing.T, pool *pgxpool.Pool, orgID string) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		INSERT INTO orgs (org_id, leader_pubkey, leader_wallet_address, org_name, domain)
		VALUES ($1, $2, $3, $4, $5)
	`, orgID, strings.Repeat("a", 64), "wevibe1testleaderwallet", "Test Org", "test.example.com")
	if err != nil {
		t.Fatalf("seed org: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", orgID) })
}

func seedCommittedSubmission(t *testing.T, pool *pgxpool.Pool, orgID, memoryHash string) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO pending_submissions (submission_hash, org_id, epoch_id, contributor_pubkey, ciphertext_hex, plaintext_hash, salt, ciphertext_hash, wrapped_dek_hash, wrapped_dek_mod, contributor_sig, status)
		VALUES ($1, $2, 1, $3, 'aa', $4, '01', $5, $6, 'mod', $7, 'committed')
	`, memoryHash, orgID, strings.Repeat("b", 64), strings.Repeat("c", 64), strings.Repeat("d", 64), strings.Repeat("e", 64), strings.Repeat("f", 128))
	if err != nil {
		t.Fatalf("seed committed submission: %v", err)
	}
}
