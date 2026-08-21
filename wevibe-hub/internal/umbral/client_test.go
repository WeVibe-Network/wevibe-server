//go:build integration
// +build integration

package umbral

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/umbral/umbralpb"
)

const (
	sidecarAddr   = "127.0.0.1:4460"
	umbralCLI     = "/Users/jerrysmith/Desktop/wevibe-workspace/wevibe-umbral/target/release/wevibe-umbral"
	epochSeedHex  = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
	memberSeedHex = "f0e0d0c0b0a09080706050403020100ffefdfcfbfaf9f8f7f6f5f4f3f2f1f0ef"
)

type deriveEpochKeypairOutput struct {
	SecretKey string `json:"secret_key"`
	PublicKey string `json:"public_key"`
}

type encryptOutput struct {
	Capsule    string `json:"capsule"`
	Ciphertext string `json:"ciphertext"`
}

func TestSidecarIntegration_LeaderMintedKFragLifecycle(t *testing.T) {
	ctx := context.Background()

	c, err := NewClient(sidecarAddr)
	if err != nil {
		t.Fatalf("failed to connect to sidecar: %v", err)
	}
	defer c.Close()

	healthBefore, err := c.Health(ctx)
	if err != nil {
		t.Fatalf("Health RPC failed: %v", err)
	}
	if !healthBefore.Healthy {
		t.Fatal("sidecar reports unhealthy")
	}

	epochSKHex, epochPKHex := deriveEpochKeypair(t, epochSeedHex)
	_, memberPKHex := deriveEpochKeypair(t, memberSeedHex)
	kfragHex := generateKFrag(t, epochSKHex, memberPKHex)
	capsuleHex, ciphertextHex := encryptForEpoch(t, epochPKHex, "68656c6c6f2d776576696265")

	if ciphertextHex == "" {
		t.Fatal("expected non-empty ciphertext from encrypt command")
	}

	memberPK := mustDecodeHex(t, "member public key", memberPKHex)
	if len(memberPK) != 33 {
		t.Fatalf("member public key wrong length: got %d, want 33", len(memberPK))
	}

	orgID := "test-org-leader-mint-" + strconv.FormatInt(time.Now().UnixNano(), 10)

	_, err = c.sidecar.StoreKFrag(ctx, &umbralpb.StoreKFragRequest{
		OrgId:    orgID,
		MemberPk: memberPK,
		Kfrag:    mustDecodeHex(t, "kfrag", kfragHex),
	})
	if err != nil {
		t.Fatalf("StoreKFrag failed: %v", err)
	}

	reEncryptResp, err := c.ReEncrypt(ctx, &umbralpb.ReEncryptRequest{
		OrgId:    orgID,
		MemberPk: memberPK,
		Capsule:  mustDecodeHex(t, "capsule", capsuleHex),
	})
	if err != nil {
		t.Fatalf("ReEncrypt failed: %v", err)
	}
	if len(reEncryptResp.Cfrag) == 0 {
		t.Fatal("re-encrypt returned empty cfrag")
	}

	deletedMemberResp, err := c.DeleteKFrags(ctx, &umbralpb.DeleteKFragsRequest{
		OrgId:    orgID,
		MemberPk: memberPK,
	})
	if err != nil {
		t.Fatalf("DeleteKFrags failed: %v", err)
	}
	if deletedMemberResp.DeletedCount == 0 {
		t.Fatal("DeleteKFrags should delete at least one kfrag")
	}

	_, err = c.DeleteOrgKFrags(ctx, &umbralpb.DeleteOrgKFragsRequest{OrgId: orgID})
	if err != nil {
		t.Fatalf("DeleteOrgKFrags failed: %v", err)
	}

	healthAfter, err := c.Health(ctx)
	if err != nil {
		t.Fatalf("Health after lifecycle failed: %v", err)
	}
	if !healthAfter.Healthy {
		t.Fatal("sidecar became unhealthy")
	}
}

func TestSidecarIntegration_DeleteOrgKFragsIdempotent(t *testing.T) {
	ctx := context.Background()

	c, err := NewClient(sidecarAddr)
	if err != nil {
		t.Fatalf("failed to connect to sidecar: %v", err)
	}
	defer c.Close()

	epochSKHex, _ := deriveEpochKeypair(t, epochSeedHex)
	_, memberOnePKHex := deriveEpochKeypair(t, memberSeedHex)
	_, memberTwoPKHex := deriveEpochKeypair(t, "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff")

	orgID := "test-org-delete-org-" + strconv.FormatInt(time.Now().UnixNano(), 10)

	mustStoreKFrag(t, ctx, c, orgID, epochSKHex, memberOnePKHex)
	mustStoreKFrag(t, ctx, c, orgID, epochSKHex, memberTwoPKHex)

	deletedResp, err := c.DeleteOrgKFrags(ctx, &umbralpb.DeleteOrgKFragsRequest{OrgId: orgID})
	if err != nil {
		t.Fatalf("DeleteOrgKFrags failed: %v", err)
	}
	if deletedResp.DeletedCount == 0 {
		t.Fatal("DeleteOrgKFrags should delete at least one kfrag")
	}

	deletedAgainResp, err := c.DeleteOrgKFrags(ctx, &umbralpb.DeleteOrgKFragsRequest{OrgId: orgID})
	if err != nil {
		t.Fatalf("DeleteOrgKFrags second call failed: %v", err)
	}
	if deletedAgainResp.DeletedCount != 0 {
		t.Fatalf("expected idempotent second delete to remove 0 kfrags, got %d", deletedAgainResp.DeletedCount)
	}
}

func mustStoreKFrag(t *testing.T, ctx context.Context, c *client, orgID string, epochSKHex, memberPKHex string) {
	t.Helper()
	kfragHex := generateKFrag(t, epochSKHex, memberPKHex)
	memberPK := mustDecodeHex(t, "member public key", memberPKHex)

	_, err := c.sidecar.StoreKFrag(ctx, &umbralpb.StoreKFragRequest{
		OrgId:    orgID,
		MemberPk: memberPK,
		Kfrag:    mustDecodeHex(t, "kfrag", kfragHex),
	})
	if err != nil {
		t.Fatalf("StoreKFrag failed: %v", err)
	}
}

func deriveEpochKeypair(t *testing.T, seedHex string) (secretKeyHex, publicKeyHex string) {
	t.Helper()
	output := runUmbralCLI(t, "derive-epoch-keypair", "--seed", seedHex)

	var parsed deriveEpochKeypairOutput
	if err := json.Unmarshal([]byte(output), &parsed); err != nil {
		t.Fatalf("failed to parse derive-epoch-keypair output %q: %v", output, err)
	}
	if parsed.SecretKey == "" {
		t.Fatal("derive-epoch-keypair returned empty secret_key")
	}
	if parsed.PublicKey == "" {
		t.Fatal("derive-epoch-keypair returned empty public_key")
	}

	secretKey := mustDecodeHex(t, "secret_key", parsed.SecretKey)
	if len(secretKey) != 32 {
		t.Fatalf("secret_key wrong length: got %d, want 32", len(secretKey))
	}

	publicKey := mustDecodeHex(t, "public_key", parsed.PublicKey)
	if len(publicKey) != 33 {
		t.Fatalf("public_key wrong length: got %d, want 33", len(publicKey))
	}

	return parsed.SecretKey, parsed.PublicKey
}

func generateKFrag(t *testing.T, delegatingSKHex, receivingPKHex string) string {
	t.Helper()
	output := runUmbralCLI(t,
		"generate-kfrags",
		"--delegating-sk", delegatingSKHex,
		"--receiving-pk", receivingPKHex,
	)
	if output == "" {
		t.Fatal("generate-kfrags returned empty output")
	}
	return output
}

func encryptForEpoch(t *testing.T, epochPKHex, plaintextHex string) (capsuleHex, ciphertextHex string) {
	t.Helper()
	output := runUmbralCLI(t,
		"encrypt",
		"--epoch-pk", epochPKHex,
		"--plaintext", plaintextHex,
	)

	var parsed encryptOutput
	if err := json.Unmarshal([]byte(output), &parsed); err != nil {
		t.Fatalf("failed to parse encrypt output %q: %v", output, err)
	}
	if parsed.Capsule == "" {
		t.Fatal("encrypt returned empty capsule")
	}
	if parsed.Ciphertext == "" {
		t.Fatal("encrypt returned empty ciphertext")
	}

	return parsed.Capsule, parsed.Ciphertext
}

func runUmbralCLI(t *testing.T, args ...string) string {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, umbralCLI, args...)
	output, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		t.Fatalf("umbral CLI timed out for args %v", args)
	}
	if err != nil {
		t.Fatalf("umbral CLI command failed: %v\nargs: %v\noutput: %s", err, args, output)
	}

	trimmed := strings.TrimSpace(string(output))
	if trimmed == "" {
		t.Fatalf("umbral CLI command produced no output for args %v", args)
	}

	return trimmed
}

func mustDecodeHex(t *testing.T, label, value string) []byte {
	t.Helper()

	decoded, err := hex.DecodeString(value)
	if err != nil {
		t.Fatalf("failed to decode %s hex %q: %v", label, value, err)
	}
	if len(decoded) == 0 {
		t.Fatalf("decoded %s is empty", label)
	}

	return decoded
}
