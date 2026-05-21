package chain

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func TestComputeMerkleRoot_Empty(t *testing.T) {
	root := ComputeMerkleRoot([][]byte{})
	expected := "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	if root != expected {
		t.Errorf("empty root = %s, want %s", root, expected)
	}
}

func TestComputeMerkleRoot_OneLeaf(t *testing.T) {
	leaf := []byte("abc")
	root := ComputeMerkleRoot([][]byte{leaf})
	h := sha256.Sum256(leaf)
	expected := hex.EncodeToString(h[:])
	if root != expected {
		t.Errorf("one leaf root = %s, want %s", root, expected)
	}
}

func TestComputeMerkleRoot_TwoLeaves(t *testing.T) {
	leaf1 := []byte("abc")
	leaf2 := []byte("def")
	h := sha256.Sum256(append(leaf1, leaf2...))
	expected := hex.EncodeToString(h[:])
	root := ComputeMerkleRoot([][]byte{leaf1, leaf2})
	if root != expected {
		t.Errorf("two leaves root = %s, want %s", root, expected)
	}
}

func TestComputeMerkleRoot_OddLeaves_Padded(t *testing.T) {
	leaf1 := []byte("abc")
	leaf2 := []byte("def")
	leaf3 := []byte("ghi")
	h1 := sha256.Sum256(append(leaf1, leaf2...))
	h2 := sha256.Sum256(append(leaf3, leaf3...))
	hCombined := sha256.Sum256(append(h1[:], h2[:]...))
	expected := hex.EncodeToString(hCombined[:])
	root := ComputeMerkleRoot([][]byte{leaf1, leaf2, leaf3})
	if root != expected {
		t.Errorf("odd leaves root = %s, want %s", root, expected)
	}
}

func TestComputeMerkleRoot_Deterministic(t *testing.T) {
	leaves := make([][]byte, 10)
	for i := 0; i < 10; i++ {
		leaves[i] = []byte{byte(i)}
	}
	root1 := ComputeMerkleRoot(leaves)
	root2 := ComputeMerkleRoot(leaves)
	if root1 != root2 {
		t.Errorf("non-deterministic: root1=%s root2=%s", root1, root2)
	}
	if root1 == "0000000000000000000000000000000000000000000000000000000000000000" {
		t.Errorf("root appears to be zero hash")
	}
}