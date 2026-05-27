package verify

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
)

func CreateOrgMessage(orgID, leaderPubkey, leaderX25519Pubkey, orgName, domain, encEnvelope, searchEnvelope, modEnvelope, pkMod string, feeModel protocol.FeeModel) []byte {
	fmHash := feeModelHash(feeModel)
	return []byte(strings.Join([]string{
		"wevibe.create_org.v1",
		fmt.Sprintf("domain:%s", domain),
		fmt.Sprintf("enc_envelope:%s", encEnvelope),
		fmt.Sprintf("fee_model_hash:%s", fmHash),
		fmt.Sprintf("leader_pubkey:%s", leaderPubkey),
		fmt.Sprintf("leader_x25519_pubkey:%s", leaderX25519Pubkey),
		fmt.Sprintf("mod_envelope:%s", modEnvelope),
		fmt.Sprintf("org_id:%s", orgID),
		fmt.Sprintf("org_name:%s", orgName),
		fmt.Sprintf("pk_mod:%s", pkMod),
		fmt.Sprintf("search_envelope:%s", searchEnvelope),
	}, "\n"))
}

func InviteMemberMessage(orgID, pubkey, x25519Pubkey, role, signedBy, encEnvelope, searchEnvelope, modEnvelope string) []byte {
	return []byte(strings.Join([]string{
		"wevibe.invite_member.v1",
		fmt.Sprintf("enc_envelope:%s", encEnvelope),
		fmt.Sprintf("mod_envelope:%s", modEnvelope),
		fmt.Sprintf("org_id:%s", orgID),
		fmt.Sprintf("pubkey:%s", pubkey),
		fmt.Sprintf("role:%s", role),
		fmt.Sprintf("search_envelope:%s", searchEnvelope),
		fmt.Sprintf("signed_by:%s", signedBy),
		fmt.Sprintf("x25519_pubkey:%s", x25519Pubkey),
	}, "\n"))
}

func RotateEpochMessage(orgID, newPkMod, signedBy string, envelopes []protocol.MemberEnvelopePair) []byte {
	envHash := envelopesHash(envelopes)
	return []byte(strings.Join([]string{
		"wevibe.rotate_epoch.v1",
		fmt.Sprintf("envelopes_hash:%s", envHash),
		fmt.Sprintf("new_pk_mod:%s", newPkMod),
		fmt.Sprintf("org_id:%s", orgID),
		fmt.Sprintf("signed_by:%s", signedBy),
	}, "\n"))
}

func RemoveMemberMessage(orgID, pubkey, signedBy string) []byte {
	return []byte(strings.Join([]string{
		"wevibe.remove_member.v1",
		fmt.Sprintf("org_id:%s", orgID),
		fmt.Sprintf("pubkey:%s", pubkey),
		fmt.Sprintf("signed_by:%s", signedBy),
	}, "\n"))
}

func UpdateMemberRoleMessage(orgID, pubkey, role, signedBy string) []byte {
	return []byte(strings.Join([]string{
		"wevibe.update_member_role.v1",
		fmt.Sprintf("org_id:%s", orgID),
		fmt.Sprintf("pubkey:%s", pubkey),
		fmt.Sprintf("role:%s", role),
		fmt.Sprintf("signed_by:%s", signedBy),
	}, "\n"))
}

func TransferLeadershipMessage(orgID, newLeaderPubkey, signedBy string) []byte {
	return []byte(strings.Join([]string{
		"wevibe.transfer_leadership.v1",
		fmt.Sprintf("org_id:%s", orgID),
		fmt.Sprintf("new_leader_pubkey:%s", newLeaderPubkey),
		fmt.Sprintf("signed_by:%s", signedBy),
	}, "\n"))
}

func CloseOrgMessage(orgID, signedBy string) []byte {
	return []byte(strings.Join([]string{
		"wevibe.close_org.v1",
		fmt.Sprintf("org_id:%s", orgID),
		fmt.Sprintf("signed_by:%s", signedBy),
	}, "\n"))
}

func feeModelHash(feeModel protocol.FeeModel) string {
	var b strings.Builder
	b.WriteByte('{')
	first := true

	writeField := func(key, value string) {
		if !first {
			b.WriteByte(',')
		}
		b.WriteByte('"')
		b.WriteString(key)
		b.WriteString(`":`)
		b.WriteString(value)
		first = false
	}

	if feeModel.Tier != "" {
		writeField("tier", `"`+feeModel.Tier+`"`)
	}
	if feeModel.MonthlyCredits != 0 {
		writeField("monthly_credits", strconv.FormatInt(feeModel.MonthlyCredits, 10))
	}
	if feeModel.PerQueryCost != 0 {
		writeField("per_query_cost", strconv.FormatInt(feeModel.PerQueryCost, 10))
	}
	if feeModel.OverageMultiplier != 0 {
		writeField("overage_multiplier", strconv.FormatFloat(feeModel.OverageMultiplier, 'f', -1, 64))
	}
	if feeModel.Currency != "" {
		writeField("currency", `"`+feeModel.Currency+`"`)
	}

	b.WriteByte('}')
	canonical := b.String()

	h := sha256.Sum256([]byte(canonical))
	return hex.EncodeToString(h[:])
}

func envelopesHash(envelopes []protocol.MemberEnvelopePair) string {
	sorted := make([]protocol.MemberEnvelopePair, len(envelopes))
	copy(sorted, envelopes)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i].Pubkey < sorted[j].Pubkey
	})

	var entries []string
	for _, e := range sorted {
		modEnv := ""
		if e.ModEnvelope != nil {
			modEnv = *e.ModEnvelope
		}
		entry := strings.Join([]string{
			fmt.Sprintf("enc_envelope:%s", e.EncEnvelope),
			fmt.Sprintf("mod_envelope:%s", modEnv),
			fmt.Sprintf("pubkey:%s", e.Pubkey),
			fmt.Sprintf("search_envelope:%s", e.SearchEnvelope),
		}, "\n")
		entries = append(entries, entry)
	}

	joined := strings.Join(entries, "\n--\n")
	h := sha256.Sum256([]byte(joined))
	return hex.EncodeToString(h[:])
}

func SubmitMemoryMessage(
	orgID string,
	epochID int,
	submissionHash string,
	contributorPubkey string,
	memoryType string,
	ciphertextHash string,
	plaintextHash string,
	salt string,
	wrappedDekHash string,
) []byte {
	return []byte(strings.Join([]string{
		"wevibe.submit_memory.v1",
		fmt.Sprintf("ciphertext_hash:%s", ciphertextHash),
		fmt.Sprintf("contributor_pubkey:%s", contributorPubkey),
		fmt.Sprintf("epoch_id:%d", epochID),
		fmt.Sprintf("memory_type:%s", memoryType),
		fmt.Sprintf("org_id:%s", orgID),
		fmt.Sprintf("plaintext_hash:%s", plaintextHash),
		fmt.Sprintf("salt:%s", salt),
		fmt.Sprintf("submission_hash:%s", submissionHash),
		fmt.Sprintf("wrapped_dek_hash:%s", wrappedDekHash),
	}, "\n"))
}

func ApproveSubmissionMessage(orgID, submissionHash string, epochID int32, approvedCID, umbralCapsule, umbralCiphertext, memoryType, signedBy string, keywords []protocol.KeywordWithWeight) []byte {
	keywordHash := keywordsHash(keywords)
	return []byte(strings.Join([]string{
		"wevibe.approve_submission.v1",
		fmt.Sprintf("approved_cid:%s", approvedCID),
		fmt.Sprintf("keywords_hash:%s", keywordHash),
		fmt.Sprintf("epoch_id:%d", epochID),
		fmt.Sprintf("memory_type:%s", memoryType),
		fmt.Sprintf("org_id:%s", orgID),
		fmt.Sprintf("signed_by:%s", signedBy),
		fmt.Sprintf("submission_hash:%s", submissionHash),
		fmt.Sprintf("umbral_capsule:%s", umbralCapsule),
		fmt.Sprintf("umbral_ciphertext:%s", umbralCiphertext),
	}, "\n"))
}

func ApproveSubmissionMessageSimple(orgID, submissionHash string, epochID int32, memoryType, signedBy string) []byte {
	return []byte(strings.Join([]string{
		"wevibe.approve_submission.v2",
		fmt.Sprintf("epoch_id:%d", epochID),
		fmt.Sprintf("memory_type:%s", memoryType),
		fmt.Sprintf("org_id:%s", orgID),
		fmt.Sprintf("signed_by:%s", signedBy),
		fmt.Sprintf("submission_hash:%s", submissionHash),
	}, "\n"))
}

func DenySubmissionMessage(orgID, submissionHash, reason, signedBy string) []byte {
	return []byte(strings.Join([]string{
		"wevibe.deny_submission.v1",
		fmt.Sprintf("org_id:%s", orgID),
		fmt.Sprintf("reason:%s", reason),
		fmt.Sprintf("signed_by:%s", signedBy),
		fmt.Sprintf("submission_hash:%s", submissionHash),
	}, "\n"))
}

func keywordsHash(keywords []protocol.KeywordWithWeight) string {
	sorted := make([]protocol.KeywordWithWeight, len(keywords))
	copy(sorted, keywords)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i].Keyword < sorted[j].Keyword
	})
	var entries []string
	for _, kw := range sorted {
		entries = append(entries, fmt.Sprintf("%s:%.6f", kw.Keyword, kw.Weight))
	}
	joined := strings.Join(entries, "\n")
	h := sha256.Sum256([]byte(joined))
	return hex.EncodeToString(h[:])
}
