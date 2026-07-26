package members

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/db"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/orgs"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
)

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

func testPubkey(t *testing.T, suffix string) string {
	return strings.Repeat(fmt.Sprintf("%c", 'a'+t.Name()[0]%26), 64-len(suffix)) + suffix
}

func TestInviteMember_GetMember(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := "test-org-" + fmt.Sprintf("%d", time.Now().UnixNano())
	leaderPubkey := strings.Repeat("a", 64)
	memberPubkey := strings.Repeat("b", 64)

	orgReq := protocol.CreateOrgRequest{
		LeaderPubkey:       leaderPubkey,
		LeaderX25519Pubkey: strings.Repeat("c", 64),
		LeaderWallet:       "wevibe1memberstest1",
		OrgName:            "Test Org",
		Domain:             "test.example.com",
		FeeModel:           protocol.FeeModel{},
		Signature:          strings.Repeat("d", 128),
		ModEnvelope:        "dGVzdC1tb2QtZW52ZWxvcGU=",
	}
	_, err := orgs.CreateOrg(ctx, pool, orgID, orgReq)
	if err != nil {
		t.Fatalf("CreateOrg failed: %v", err)
	}

	epoch, _ := orgs.GetCurrentEpoch(ctx, pool, orgID)
	inviteReq := protocol.InviteMemberRequest{
		Pubkey:       memberPubkey,
		X25519Pubkey: strings.Repeat("e", 64),
		Role:         "member",
		SignedBy:     leaderPubkey,
		Signature:    strings.Repeat("f", 128),
	}

	member, err := InviteMember(ctx, pool, orgID, epoch, inviteReq)
	if err != nil {
		t.Fatalf("InviteMember failed: %v", err)
	}
	if member.Pubkey != memberPubkey {
		t.Errorf("expected pubkey %s, got %s", memberPubkey, member.Pubkey)
	}
	if member.Role != "member" {
		t.Errorf("expected role 'member', got %s", member.Role)
	}

	got, err := GetMember(ctx, pool, orgID, memberPubkey)
	if err != nil {
		t.Fatalf("GetMember failed: %v", err)
	}
	if got.Pubkey != memberPubkey {
		t.Errorf("expected pubkey %s, got %s", memberPubkey, got.Pubkey)
	}

	t.Cleanup(func() {
		pool.Exec(ctx, "DELETE FROM members WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM epoch_manifests WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", orgID)
	})
}

func TestGetMember_NotFound(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := "test-org-" + fmt.Sprintf("%d", time.Now().UnixNano())
	leaderPubkey := strings.Repeat("a", 64)

	orgReq := protocol.CreateOrgRequest{
		LeaderPubkey:       leaderPubkey,
		LeaderX25519Pubkey: strings.Repeat("b", 64),
		LeaderWallet:       "wevibe1memberstest2",
		OrgName:            "Test Org",
		Domain:             "test.example.com",
		FeeModel:           protocol.FeeModel{},
		Signature:          strings.Repeat("c", 128),
		ModEnvelope:        "dGVzdC1tb2QtZW52ZWxvcGU=",
	}
	_, err := orgs.CreateOrg(ctx, pool, orgID, orgReq)
	if err != nil {
		t.Fatalf("CreateOrg failed: %v", err)
	}

	_, err = GetMember(ctx, pool, orgID, "nonexistent")
	if err == nil {
		t.Fatal("expected error for nonexistent member")
	}

	t.Cleanup(func() {
		pool.Exec(ctx, "DELETE FROM members WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM epoch_manifests WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", orgID)
	})
}

func TestRemoveMember(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := "test-org-" + fmt.Sprintf("%d", time.Now().UnixNano())
	leaderPubkey := strings.Repeat("a", 64)
	memberPubkey := strings.Repeat("b", 64)

	orgReq := protocol.CreateOrgRequest{
		LeaderPubkey:       leaderPubkey,
		LeaderX25519Pubkey: strings.Repeat("c", 64),
		LeaderWallet:       "wevibe1memberstest3",
		OrgName:            "Test Org",
		Domain:             "test.example.com",
		FeeModel:           protocol.FeeModel{},
		Signature:          strings.Repeat("d", 128),
		ModEnvelope:        "dGVzdC1tb2QtZW52ZWxvcGU=",
	}
	_, err := orgs.CreateOrg(ctx, pool, orgID, orgReq)
	if err != nil {
		t.Fatalf("CreateOrg failed: %v", err)
	}

	epoch, _ := orgs.GetCurrentEpoch(ctx, pool, orgID)
	inviteReq := protocol.InviteMemberRequest{
		Pubkey:       memberPubkey,
		X25519Pubkey: strings.Repeat("e", 64),
		Role:         "member",
		SignedBy:     leaderPubkey,
		Signature:    strings.Repeat("f", 128),
	}
	_, err = InviteMember(ctx, pool, orgID, epoch, inviteReq)
	if err != nil {
		t.Fatalf("InviteMember failed: %v", err)
	}

	err = RemoveMember(ctx, pool, orgID, memberPubkey, epoch)
	if err != nil {
		t.Fatalf("RemoveMember failed: %v", err)
	}

	member, err := GetMember(ctx, pool, orgID, memberPubkey)
	if err != nil {
		t.Fatalf("GetMember failed: %v", err)
	}
	if member.Active {
		t.Error("expected member to be inactive after removal")
	}

	t.Cleanup(func() {
		pool.Exec(ctx, "DELETE FROM members WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM epoch_manifests WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", orgID)
	})
}

func TestListMembers(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := "test-org-" + fmt.Sprintf("%d", time.Now().UnixNano())
	leaderPubkey := strings.Repeat("a", 64)

	orgReq := protocol.CreateOrgRequest{
		LeaderPubkey:       leaderPubkey,
		LeaderX25519Pubkey: strings.Repeat("b", 64),
		LeaderWallet:       "wevibe1memberstest4",
		OrgName:            "Test Org",
		Domain:             "test.example.com",
		FeeModel:           protocol.FeeModel{},
		Signature:          strings.Repeat("c", 128),
		ModEnvelope:        "dGVzdC1tb2QtZW52ZWxvcGU=",
	}
	_, err := orgs.CreateOrg(ctx, pool, orgID, orgReq)
	if err != nil {
		t.Fatalf("CreateOrg failed: %v", err)
	}

	membersList, err := ListMembers(ctx, pool, orgID)
	if err != nil {
		t.Fatalf("ListMembers failed: %v", err)
	}
	if len(membersList) != 1 {
		t.Errorf("expected 1 member (leader), got %d", len(membersList))
	}

	epoch, _ := orgs.GetCurrentEpoch(ctx, pool, orgID)
	inviteReq := protocol.InviteMemberRequest{
		Pubkey:       strings.Repeat("d", 64),
		X25519Pubkey: strings.Repeat("e", 64),
		Role:         "member",
		SignedBy:     leaderPubkey,
		Signature:    strings.Repeat("f", 128),
	}
	_, err = InviteMember(ctx, pool, orgID, epoch, inviteReq)
	if err != nil {
		t.Fatalf("InviteMember failed: %v", err)
	}

	membersList, err = ListMembers(ctx, pool, orgID)
	if err != nil {
		t.Fatalf("ListMembers failed: %v", err)
	}
	if len(membersList) != 2 {
		t.Errorf("expected 2 members, got %d", len(membersList))
	}

	t.Cleanup(func() {
		pool.Exec(ctx, "DELETE FROM members WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM epoch_manifests WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", orgID)
	})
}

func TestVerifyMemberAccess(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := "test-org-" + fmt.Sprintf("%d", time.Now().UnixNano())
	leaderPubkey := strings.Repeat("a", 64)

	orgReq := protocol.CreateOrgRequest{
		LeaderPubkey:       leaderPubkey,
		LeaderX25519Pubkey: strings.Repeat("b", 64),
		LeaderWallet:       "wevibe1memberstest5",
		OrgName:            "Test Org",
		Domain:             "test.example.com",
		FeeModel:           protocol.FeeModel{},
		Signature:          strings.Repeat("c", 128),
		ModEnvelope:        "dGVzdC1tb2QtZW52ZWxvcGU=",
	}
	_, err := orgs.CreateOrg(ctx, pool, orgID, orgReq)
	if err != nil {
		t.Fatalf("CreateOrg failed: %v", err)
	}

	ok, err := VerifyMemberAccess(ctx, pool, orgID, leaderPubkey, 0)
	if err != nil {
		t.Fatalf("VerifyMemberAccess failed: %v", err)
	}
	if !ok {
		t.Error("expected leader to have access to epoch 0")
	}

	ok, err = VerifyMemberAccess(ctx, pool, orgID, "nonexistent", 0)
	if err != nil {
		t.Fatalf("VerifyMemberAccess failed: %v", err)
	}
	if ok {
		t.Error("expected nonexistent member to not have access")
	}

	t.Cleanup(func() {
		pool.Exec(ctx, "DELETE FROM members WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM epoch_manifests WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", orgID)
	})
}

func TestIsLeader(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := "test-org-" + fmt.Sprintf("%d", time.Now().UnixNano())
	leaderPubkey := strings.Repeat("a", 64)

	orgReq := protocol.CreateOrgRequest{
		LeaderPubkey:       leaderPubkey,
		LeaderX25519Pubkey: strings.Repeat("b", 64),
		LeaderWallet:       "wevibe1memberstest6",
		OrgName:            "Test Org",
		Domain:             "test.example.com",
		FeeModel:           protocol.FeeModel{},
		Signature:          strings.Repeat("c", 128),
		ModEnvelope:        "dGVzdC1tb2QtZW52ZWxvcGU=",
	}
	_, err := orgs.CreateOrg(ctx, pool, orgID, orgReq)
	if err != nil {
		t.Fatalf("CreateOrg failed: %v", err)
	}

	isLeader, err := IsLeader(ctx, pool, orgID, leaderPubkey)
	if err != nil {
		t.Fatalf("IsLeader failed: %v", err)
	}
	if !isLeader {
		t.Error("expected true for leader")
	}

	isLeader, err = IsLeader(ctx, pool, orgID, strings.Repeat("x", 64))
	if err != nil {
		t.Fatalf("IsLeader failed: %v", err)
	}
	if isLeader {
		t.Error("expected false for non-leader")
	}

	t.Cleanup(func() {
		pool.Exec(ctx, "DELETE FROM members WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM epoch_manifests WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", orgID)
	})
}

func TestFullMemberLifecycle(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := "test-org-" + fmt.Sprintf("%d", time.Now().UnixNano())
	leaderPubkey := strings.Repeat("a", 64)
	memberPubkey := strings.Repeat("b", 64)

	orgReq := protocol.CreateOrgRequest{
		LeaderPubkey:       leaderPubkey,
		LeaderX25519Pubkey: strings.Repeat("c", 64),
		LeaderWallet:       "wevibe1memberstest7",
		OrgName:            "Test Org",
		Domain:             "test.example.com",
		FeeModel:           protocol.FeeModel{},
		Signature:          strings.Repeat("d", 128),
		ModEnvelope:        "dGVzdC1tb2QtZW52ZWxvcGU=",
	}
	_, err := orgs.CreateOrg(ctx, pool, orgID, orgReq)
	if err != nil {
		t.Fatalf("CreateOrg failed: %v", err)
	}

	epoch, _ := orgs.GetCurrentEpoch(ctx, pool, orgID)
	inviteReq := protocol.InviteMemberRequest{
		Pubkey:       memberPubkey,
		X25519Pubkey: strings.Repeat("e", 64),
		Role:         "member",
		SignedBy:     leaderPubkey,
		Signature:    strings.Repeat("f", 128),
	}
	member, err := InviteMember(ctx, pool, orgID, epoch, inviteReq)
	if err != nil {
		t.Fatalf("InviteMember failed: %v", err)
	}
	if !member.Active {
		t.Error("expected new member to be active")
	}

	ok, err := VerifyMemberAccess(ctx, pool, orgID, memberPubkey, 0)
	if err != nil {
		t.Fatalf("VerifyMemberAccess failed: %v", err)
	}
	if !ok {
		t.Error("expected member to have access")
	}

	err = RemoveMember(ctx, pool, orgID, memberPubkey, epoch)
	if err != nil {
		t.Fatalf("RemoveMember failed: %v", err)
	}

	member, err = GetMember(ctx, pool, orgID, memberPubkey)
	if err != nil {
		t.Fatalf("GetMember failed: %v", err)
	}
	if member.Active {
		t.Error("expected member to be inactive after removal")
	}

	t.Cleanup(func() {
		pool.Exec(ctx, "DELETE FROM members WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM epoch_manifests WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", orgID)
	})
}

func TestListOrgsForMember(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := "test-org-" + fmt.Sprintf("%d", time.Now().UnixNano())
	leaderPubkey := testPubkey(t, "l")
	memberPubkey := testPubkey(t, "m")

	orgReq := protocol.CreateOrgRequest{
		LeaderPubkey:       leaderPubkey,
		LeaderX25519Pubkey: testPubkey(t, "lx"),
		LeaderWallet:       "wevibe1memberstest8",
		OrgName:            "Test Org",
		Domain:             "test.example.com",
		FeeModel:           protocol.FeeModel{},
		Signature:          testPubkey(t, "s"),
		ModEnvelope:        "dGVzdC1tb2QtZW52ZWxvcGU=",
	}
	_, err := orgs.CreateOrg(ctx, pool, orgID, orgReq)
	if err != nil {
		t.Fatalf("CreateOrg failed: %v", err)
	}

	entries, err := ListOrgsForMember(ctx, pool, leaderPubkey)
	if err != nil {
		t.Fatalf("ListOrgsForMember failed: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 org for leader, got %d", len(entries))
	}
	if entries[0].OrgID != orgID {
		t.Errorf("expected org_id %s, got %s", orgID, entries[0].OrgID)
	}
	if entries[0].Role != "leader" {
		t.Errorf("expected role 'leader', got %s", entries[0].Role)
	}

	epoch, _ := orgs.GetCurrentEpoch(ctx, pool, orgID)
	inviteReq := protocol.InviteMemberRequest{
		Pubkey:       memberPubkey,
		X25519Pubkey: strings.Repeat("e", 64),
		Role:         "member",
		SignedBy:     leaderPubkey,
		Signature:    strings.Repeat("f", 128),
	}
	_, err = InviteMember(ctx, pool, orgID, epoch, inviteReq)
	if err != nil {
		t.Fatalf("InviteMember failed: %v", err)
	}

	entries, err = ListOrgsForMember(ctx, pool, memberPubkey)
	if err != nil {
		t.Fatalf("ListOrgsForMember failed: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 org for member, got %d", len(entries))
	}
	if entries[0].Role != "member" {
		t.Errorf("expected role 'member', got %s", entries[0].Role)
	}

	t.Cleanup(func() {
		pool.Exec(ctx, "DELETE FROM members WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM epoch_manifests WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", orgID)
	})
}

func TestListOrgsForMember_NoMemberships(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()

	entries, err := ListOrgsForMember(ctx, pool, strings.Repeat("x", 64))
	if err != nil {
		t.Fatalf("ListOrgsForMember failed: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("expected 0 orgs, got %d", len(entries))
	}
}

func TestListOrgsForMember_InactiveExcluded(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := "test-org-" + fmt.Sprintf("%d", time.Now().UnixNano())
	leaderPubkey := strings.Repeat("a", 64)
	memberPubkey := strings.Repeat("b", 64)

	orgReq := protocol.CreateOrgRequest{
		LeaderPubkey:       leaderPubkey,
		LeaderX25519Pubkey: strings.Repeat("c", 64),
		LeaderWallet:       "wevibe1memberstest9",
		OrgName:            "Test Org",
		Domain:             "test.example.com",
		FeeModel:           protocol.FeeModel{},
		Signature:          strings.Repeat("d", 128),
		ModEnvelope:        "dGVzdC1tb2QtZW52ZWxvcGU=",
	}
	_, err := orgs.CreateOrg(ctx, pool, orgID, orgReq)
	if err != nil {
		t.Fatalf("CreateOrg failed: %v", err)
	}

	epoch, _ := orgs.GetCurrentEpoch(ctx, pool, orgID)
	inviteReq := protocol.InviteMemberRequest{
		Pubkey:       memberPubkey,
		X25519Pubkey: strings.Repeat("e", 64),
		Role:         "member",
		SignedBy:     leaderPubkey,
		Signature:    strings.Repeat("f", 128),
	}
	_, err = InviteMember(ctx, pool, orgID, epoch, inviteReq)
	if err != nil {
		t.Fatalf("InviteMember failed: %v", err)
	}

	entries, err := ListOrgsForMember(ctx, pool, memberPubkey)
	if err != nil {
		t.Fatalf("ListOrgsForMember failed: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 org before removal, got %d", len(entries))
	}

	RemoveMember(ctx, pool, orgID, memberPubkey, epoch)

	entries, err = ListOrgsForMember(ctx, pool, memberPubkey)
	if err != nil {
		t.Fatalf("ListOrgsForMember failed: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("expected 0 orgs for inactive member, got %d", len(entries))
	}

	t.Cleanup(func() {
		pool.Exec(ctx, "DELETE FROM members WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM epoch_manifests WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", orgID)
	})
}
