package handlers

import (
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"
)

func ReEncrypt(w http.ResponseWriter, r *http.Request) {
	if umbralService == nil {
		http.Error(w, `{"error":"umbral service not available"}`, http.StatusServiceUnavailable)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req struct {
		OrgID    string `json:"org_id"`
		EpochID  uint64 `json:"epoch_id"`
		MemberPK string `json:"member_pk"`
		Capsule  string `json:"capsule"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	if req.OrgID == "" || req.MemberPK == "" || req.Capsule == "" {
		http.Error(w, `{"error":"org_id, member_pk, and capsule are required"}`, http.StatusBadRequest)
		return
	}

	memberPKBytes, err := hex.DecodeString(req.MemberPK)
	if err != nil {
		http.Error(w, `{"error":"invalid member_pk format"}`, http.StatusBadRequest)
		return
	}

	capsuleBytes, err := hex.DecodeString(req.Capsule)
	if err != nil {
		http.Error(w, `{"error":"invalid capsule format"}`, http.StatusBadRequest)
		return
	}

	cfrag, err := umbralService.ReEncryptForMember(r.Context(), req.OrgID, req.EpochID, memberPKBytes, capsuleBytes)
	if err != nil {
		http.Error(w, `{"error":"re-encryption failed: `+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"cfrag": hex.EncodeToString(cfrag),
	})
}

func ReEncryptForMember(w http.ResponseWriter, r *http.Request) {
	ReEncrypt(w, r)
}

func GenerateEpochKeyPair(w http.ResponseWriter, r *http.Request) {
	if umbralService == nil {
		http.Error(w, `{"error":"umbral service not available"}`, http.StatusServiceUnavailable)
		return
	}

	sk, pk, err := umbralService.GenerateEpochKeyPair(r.Context())
	if err != nil {
		http.Error(w, `{"error":"keypair generation failed: `+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"secret_key": hex.EncodeToString(sk),
		"public_key": hex.EncodeToString(pk),
	})
}

func GenerateKFrags(w http.ResponseWriter, r *http.Request) {
	if umbralService == nil {
		http.Error(w, `{"error":"umbral service not available"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req struct {
		EpochID       uint64 `json:"epoch_id"`
		DelegatingSK  string `json:"delegating_sk"`
		ReceivingPK   string `json:"receiving_pk"`
		SignerSK      string `json:"signer_sk"`
		VerifyingPK   string `json:"verifying_pk"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	delegatingSKBytes, err := hex.DecodeString(req.DelegatingSK)
	if err != nil {
		http.Error(w, `{"error":"invalid delegating_sk"}`, http.StatusBadRequest)
		return
	}
	receivingPKBytes, err := hex.DecodeString(req.ReceivingPK)
	if err != nil {
		http.Error(w, `{"error":"invalid receiving_pk"}`, http.StatusBadRequest)
		return
	}
	signerSKBytes, err := hex.DecodeString(req.SignerSK)
	if err != nil {
		http.Error(w, `{"error":"invalid signer_sk"}`, http.StatusBadRequest)
		return
	}
	verifyingPKBytes, err := hex.DecodeString(req.VerifyingPK)
	if err != nil {
		http.Error(w, `{"error":"invalid verifying_pk"}`, http.StatusBadRequest)
		return
	}

	kfrag, err := umbralService.RegisterMember(r.Context(), orgID, req.EpochID, delegatingSKBytes, receivingPKBytes, signerSKBytes, verifyingPKBytes)
	if err != nil {
		http.Error(w, `{"error":"kfrag generation failed: `+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"kfrag": hex.EncodeToString(kfrag),
	})
}