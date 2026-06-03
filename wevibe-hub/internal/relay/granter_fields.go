package relay

var GranterFieldByMsgType = map[string]string{
	"/wevibe.memory.v1.MsgSubmitCommitment": "signer",
	"/wevibe.memory.v1.MsgApproveMemory":    "signer",
	"/wevibe.memory.v1.MsgReportMemory":     "signer",
	"/wevibe.serve.v1.MsgSubmitServeBatch":  "signer",
	"/wevibe.serve.v1.MsgSubmitDenialBatch": "signer",
	"/wevibe.org.v1.MsgRegisterOrg":         "signer",
	"/wevibe.org.v1.MsgAddMember":           "signer",
	"/wevibe.org.v1.MsgRemoveMember":        "signer",
	"/wevibe.org.v1.MsgSetOrgConfig":        "signer",
	"/wevibe.org.v1.MsgUpdateMemberRole":    "signer",
	"/wevibe.org.v1.MsgRotateEpoch":         "signer",
}

func IsRelayAllowed(typeURL string) bool {
	_, ok := GranterFieldByMsgType[typeURL]
	return ok
}
