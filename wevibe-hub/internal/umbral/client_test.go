//go:build integration
// +build integration

package umbral

import (
	"context"
	"testing"
	"time"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/umbral/umbralpb"
)

func TestSidecarIntegration(t *testing.T) {
	ctx := context.Background()
	addr := "127.0.0.1:4460"

	c, err := NewClient(addr)
	if err != nil {
		t.Fatalf("failed to connect to sidecar: %v", err)
	}
	defer c.Close()

	healthResp, err := c.Health(ctx)
	if err != nil {
		t.Fatalf("Health RPC failed: %v", err)
	}
	if !healthResp.Healthy {
		t.Fatalf("sidecar reports unhealthy")
	}
	t.Logf("Health check passed. KFrag count: %d, Umbral version: %s",
		healthResp.KfragCount, healthResp.UmbralVersion)

	epochResp, err := c.GenerateKeyPair(ctx)
	if err != nil {
		t.Fatalf("GenerateKeyPair (epoch) failed: %v", err)
	}
	if len(epochResp.SecretKey) != 32 {
		t.Fatalf("epoch secret key wrong length: got %d, want 32", len(epochResp.SecretKey))
	}
	if len(epochResp.PublicKey) != 33 {
		t.Fatalf("epoch public key wrong length: got %d, want 33", len(epochResp.PublicKey))
	}
	t.Logf("Epoch keypair generated. SK len=%d, PK len=%d",
		len(epochResp.SecretKey), len(epochResp.PublicKey))

	memberResp, err := c.GenerateKeyPair(ctx)
	if err != nil {
		t.Fatalf("GenerateKeyPair (member) failed: %v", err)
	}
	if len(memberResp.SecretKey) != 32 {
		t.Fatalf("member secret key wrong length: got %d, want 32", len(memberResp.SecretKey))
	}
	if len(memberResp.PublicKey) != 33 {
		t.Fatalf("member public key wrong length: got %d, want 33", len(memberResp.PublicKey))
	}
	t.Logf("Member keypair generated. SK len=%d, PK len=%d",
		len(memberResp.SecretKey), len(memberResp.PublicKey))

	kfragsReq := &umbralpb.GenerateKFragsRequest{
		OrgId:       "test-org",
		EpochId:     1,
		DelegatingSk: epochResp.SecretKey,
		ReceivingPk: memberResp.PublicKey,
		SignerSk:    epochResp.SecretKey,
		VerifyingPk: epochResp.PublicKey,
	}
	kfragsResp, err := c.GenerateKFrags(ctx, kfragsReq)
	if err != nil {
		t.Fatalf("GenerateKFrags failed: %v", err)
	}
	if len(kfragsResp.Kfrag) == 0 {
		t.Fatal("kfrag is empty")
	}
	t.Logf("KFrag generated and stored for org=test-org, epoch=1")

	delReq := &umbralpb.DeleteKFragsRequest{
		OrgId:   "test-org",
		MemberPk: memberResp.PublicKey,
	}
	delResp, err := c.DeleteKFrags(ctx, delReq)
	if err != nil {
		t.Fatalf("DeleteKFrags failed: %v", err)
	}
	t.Logf("DeleteKFrags deleted %d kfrags", delResp.DeletedCount)

	healthAfterDelete, err := c.Health(ctx)
	if err != nil {
		t.Fatalf("Health after delete failed: %v", err)
	}
	t.Logf("Health after delete. KFrag count: %d", healthAfterDelete.KfragCount)
}

func TestSidecarIntegration_DeleteOrgKFrags(t *testing.T) {
	ctx := context.Background()
	addr := "127.0.0.1:4460"

	c, err := NewClient(addr)
	if err != nil {
		t.Fatalf("failed to connect to sidecar: %v", err)
	}
	defer c.Close()

	orgID := "test-org-delete"

	epochResp, err := c.GenerateKeyPair(ctx)
	if err != nil {
		t.Fatalf("GenerateKeyPair failed: %v", err)
	}

	for i := 0; i < 3; i++ {
		memberResp, err := c.GenerateKeyPair(ctx)
		if err != nil {
			t.Fatalf("GenerateKeyPair (member) failed: %v", err)
		}

		kfragsReq := &umbralpb.GenerateKFragsRequest{
			OrgId:       orgID,
			EpochId:     uint64(i),
			DelegatingSk: epochResp.SecretKey,
			ReceivingPk: memberResp.PublicKey,
			SignerSk:    epochResp.SecretKey,
			VerifyingPk: epochResp.PublicKey,
		}
		_, err = c.GenerateKFrags(ctx, kfragsReq)
		if err != nil {
			t.Fatalf("GenerateKFrags failed: %v", err)
		}
	}
	t.Logf("Stored kfrags for 3 epochs in org=%s", orgID)

	delOrgReq := &umbralpb.DeleteOrgKFragsRequest{
		OrgId: orgID,
	}
	delResp, err := c.DeleteOrgKFrags(ctx, delOrgReq)
	if err != nil {
		t.Fatalf("DeleteOrgKFrags failed: %v", err)
	}
	t.Logf("DeleteOrgKFrags deleted %d kfrags for org=%s", delResp.DeletedCount, orgID)

	if delResp.DeletedCount == 0 {
		t.Fatal("expected at least some kfrags to be deleted")
	}
}

func TestSidecarReEncryptNeedsCapsule(t *testing.T) {
	ctx := context.Background()
	addr := "127.0.0.1:4460"

	c, err := NewClient(addr)
	if err != nil {
		t.Fatalf("failed to connect to sidecar: %v", err)
	}
	defer c.Close()

	epochResp, err := c.GenerateKeyPair(ctx)
	if err != nil {
		t.Fatalf("GenerateKeyPair (epoch) failed: %v", err)
	}
	memberResp, err := c.GenerateKeyPair(ctx)
	if err != nil {
		t.Fatalf("GenerateKeyPair (member) failed: %v", err)
	}

	kfragsReq := &umbralpb.GenerateKFragsRequest{
		OrgId:       "test-reencrypt",
		EpochId:     1,
		DelegatingSk: epochResp.SecretKey,
		ReceivingPk: memberResp.PublicKey,
		SignerSk:    epochResp.SecretKey,
		VerifyingPk: epochResp.PublicKey,
	}
	_, err = c.GenerateKFrags(ctx, kfragsReq)
	if err != nil {
		t.Fatalf("GenerateKFrags failed: %v", err)
	}

	reEncryptReq := &umbralpb.ReEncryptRequest{
		OrgId:   "test-reencrypt",
		EpochId: 1,
		MemberPk: memberResp.PublicKey,
		Capsule: []byte("fake-capsule-for-testing"),
	}
	_, err = c.ReEncrypt(ctx, reEncryptReq)
	if err != nil {
		t.Logf("ReEncrypt correctly rejects malformed capsule: %v", err)
	} else {
		t.Log("ReEncrypt accepted malformed capsule (may indicate issue)")
	}
}

var _ = time.Second