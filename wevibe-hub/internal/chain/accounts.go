package chain

// OrgKeyRole identifies the hub signer role used for org-scoped broadcasts.
type OrgKeyRole string

const (
	OrgKeyServing OrgKeyRole = "serving"
)

func (r OrgKeyRole) valid() bool {
	return r == OrgKeyServing
}
