package chain

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
)

func ComputeMerkleRoot(leaves [][]byte) string {
	if len(leaves) == 0 {
		empty := sha256.Sum256([]byte{})
		return hex.EncodeToString(empty[:])
	}
	if len(leaves) == 1 {
		h := sha256.Sum256(leaves[0])
		return hex.EncodeToString(h[:])
	}
	sorted := make([][]byte, len(leaves))
	copy(sorted, leaves)
	sort.Slice(sorted, func(i, j int) bool {
		return hex.EncodeToString(sorted[i]) < hex.EncodeToString(sorted[j])
	})
	layer := sorted
	for len(layer) > 1 {
		if len(layer)%2 != 0 {
			layer = append(layer, layer[len(layer)-1])
		}
		next := make([][]byte, len(layer)/2)
		for i := 0; i < len(layer); i += 2 {
			combined := append(layer[i], layer[i+1]...)
			h := sha256.Sum256(combined)
			next[i/2] = h[:]
		}
		layer = next
	}
	return hex.EncodeToString(layer[0])
}

func HashContribution(content []byte) []byte {
	h := sha256.Sum256(content)
	return h[:]
}
