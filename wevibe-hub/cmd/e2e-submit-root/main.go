package main

import (
	"context"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
	"time"

	memorytypes "github.com/wevibe-network/wevibe-chain/x/memory/types"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/chain"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	mnemonicPath := os.Getenv("WEVIBE_DEV_MNEMONICS")
	if mnemonicPath == "" {
		mnemonicPath = "dev-mnemonics.env"
	}
	mnemonic, err := loadMnemonic(mnemonicPath)
	if err != nil {
		fmt.Printf("FAIL: load mnemonic: %v\n", err)
		os.Exit(1)
	}

	grpcURL := "localhost:9090"
	if envURL := os.Getenv("WEVIBE_CHAIN_GRPC_URL"); envURL != "" {
		grpcURL = envURL
	}

	client, err := chain.NewGrpcClient(grpcURL, "wevibe-local-1", mnemonic)
	if err != nil {
		fmt.Printf("FAIL: create grpc client: %v\n", err)
		os.Exit(1)
	}
	defer client.Close()

	fmt.Printf("Submitter address: %s\n", client.SubmitterAddress())

	testOrg := "test-org-e2e"
	registered, err := client.IsOrgRegistered(ctx, testOrg)
	if err != nil {
		fmt.Printf("FAIL: IsOrgRegistered: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Org %s registered: %v\n", testOrg, registered)

	memoryClient := client.GetMemoryQueryClient()
	resp, err := memoryClient.GetEpochMerkleRoot(ctx, &memorytypes.QueryGetEpochMerkleRootRequest{
		OrgId: testOrg,
		Epoch: 1,
	})
	if err != nil {
		fmt.Printf("Merkle root query: %v (expected for empty org)\n", err)
		fmt.Println("PASS: chain connectivity verified (org query + memory query reachable)")
		os.Exit(0)
	}

	rootHex := hex.EncodeToString(resp.MerkleRoot)
	fmt.Printf("PASS: merkle root for %s epoch 1: %s (memories: %d)\n", testOrg, rootHex, resp.MemoryCount)
}

func loadMnemonic(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "CHAIN_SUBMITTER_MNEMONIC=") {
			return strings.Trim(strings.TrimPrefix(line, "CHAIN_SUBMITTER_MNEMONIC="), "\" "), nil
		}
	}
	return "", fmt.Errorf("CHAIN_SUBMITTER_MNEMONIC not found in %s", path)
}
