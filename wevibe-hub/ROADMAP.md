# WeVibe Hub Roadmap

## Status

The hub’s core alpha surface is implemented and operating:

- Organization and membership APIs
- Epoch and moderation queue workflows
- Keyword extraction/review and retrieval endpoints
- Recovery and billing/credits read paths
- Proxy re-encryption wiring with the Umbral sidecar
- Denial-attestation ingestion path

Known alpha gaps:

- Credit top-up is still a manual credit-injection flow (no Stripe or other live payment processor yet)
- Session-lookup and receipts endpoints are currently stubs
- Contributor reputation lookup still needs to be keyed by passkey public key

## Near-term

- Sign hub responses using each org’s on-chain serving key
- Serve chain-resolved endpoint values where the chain is canonical
- Re-key contributor reputation lookup by passkey public key
- Harden serve de-dup so the chain recomputes the fingerprint
- Replace manual top-up scaffolding with real payment processing

## Future

- Promote session-lookup and receipts from stub state to complete, auditable APIs
- Continue hardening retrieval integrity, billing reliability, and operational observability for public production use

## Design references

- https://github.com/WeVibe-Network/wevibe-docs
