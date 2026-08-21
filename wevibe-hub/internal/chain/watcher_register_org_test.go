package chain

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/jackc/pgx/v5/pgxpool"
	orgtypes "github.com/wevibe-network/wevibe-chain/x/org/types"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/db"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/orgs"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
)

func chainTestPool(t *testing.T) *pgxpool.Pool {
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

func TestProcessTx_RegisterOrg_SyncsOrgProfile(t *testing.T) {
	pool := chainTestPool(t)
	ctx := context.Background()
	orgID := fmt.Sprintf("test-org-watcher-%d", time.Now().UnixNano())
	leaderPubkey := fmt.Sprintf("%064x", time.Now().UnixNano())

	req := protocol.CreateOrgRequest{
		LeaderPubkey:       leaderPubkey,
		LeaderWallet:       fmt.Sprintf("wevibe1watcher%d", time.Now().UnixNano()),
		LeaderX25519Pubkey: strings.Repeat("b", 64),
		OrgName:            "Hub Name",
		Domain:             "hub.example",
		Description:        "hub description",
		TechStack:          "hub stack",
		FocusAreas:         "hub focus",
		FeeModel:           protocol.FeeModel{},
		PkMod:              strings.Repeat("c", 64),
		UmbralPK:           strings.Repeat("d", 64),
		Signature:          strings.Repeat("e", 128),
		EncEnvelope:        "dGVzdC1lbmMtZW52ZWxvcGU=",
		SearchEnvelope:     "dGVzdC1zZWFyY2gtZW52ZWxvcGU=",
		ModEnvelope:        "dGVzdC1tb2QtZW52ZWxvcGU=",
	}

	_, err := orgs.CreateOrg(ctx, pool, orgID, req)
	if err != nil {
		t.Fatalf("CreateOrg failed: %v", err)
	}

	t.Cleanup(func() {
		pool.Exec(ctx, "DELETE FROM members WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", orgID)
	})

	msg := &orgtypes.MsgRegisterOrg{
		Leader:      req.LeaderPubkey,
		Name:        "Chain Name",
		Domain:      "chain.example",
		Description: "chain description",
		TechStack:   "chain stack",
		FocusAreas:  "chain focus",
	}

	w := &ChainWatcher{
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		db:     pool,
		txDecoder: func([]byte) (TxInterface, error) {
			return testTx{msgs: []sdk.Msg{msg}}, nil
		},
	}

	err = w.processTx(ctx, []byte{0xAB, 0xCD}, 12345, time.Now().UTC(), []byte{0x01})
	if err != nil {
		t.Fatalf("processTx failed: %v", err)
	}

	got, err := orgs.GetOrg(ctx, pool, orgID)
	if err != nil {
		t.Fatalf("GetOrg failed: %v", err)
	}
	if got.OrgName != "Chain Name" {
		t.Fatalf("expected org_name %q, got %q", "Chain Name", got.OrgName)
	}
	if got.Domain != "chain.example" {
		t.Fatalf("expected domain %q, got %q", "chain.example", got.Domain)
	}
	if got.Description != "chain description" {
		t.Fatalf("expected description %q, got %q", "chain description", got.Description)
	}
	if got.TechStack != "chain stack" {
		t.Fatalf("expected tech_stack %q, got %q", "chain stack", got.TechStack)
	}
	if got.FocusAreas != "chain focus" {
		t.Fatalf("expected focus_areas %q, got %q", "chain focus", got.FocusAreas)
	}
}

func TestProcessTx_RegisterOrg_SkipsWhenRowAbsent(t *testing.T) {
	pool := chainTestPool(t)
	ctx := context.Background()
	missingLeader := fmt.Sprintf("missing-leader-%d", time.Now().UnixNano())

	msg := &orgtypes.MsgRegisterOrg{
		Leader:      missingLeader,
		Name:        "Chain Name",
		Domain:      "chain.example",
		Description: "chain description",
		TechStack:   "chain stack",
		FocusAreas:  "chain focus",
	}

	w := &ChainWatcher{
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		db:     pool,
		txDecoder: func([]byte) (TxInterface, error) {
			return testTx{msgs: []sdk.Msg{msg}}, nil
		},
	}

	err := w.processTx(ctx, []byte{0xAB, 0xCD}, 12345, time.Now().UTC(), []byte{0x01})
	if err != nil {
		t.Fatalf("processTx failed: %v", err)
	}

	orgID, err := orgs.GetOrgIDByLeader(ctx, pool, missingLeader)
	if err != nil {
		t.Fatalf("GetOrgIDByLeader failed: %v", err)
	}
	if orgID != "" {
		t.Fatalf("expected no org for leader %q, got org_id %q", missingLeader, orgID)
	}
}
