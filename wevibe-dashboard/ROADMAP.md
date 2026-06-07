# WeVibe Dashboard Roadmap

## Status

The dashboard’s core alpha experience is implemented and running:

- Moderation, member management, and org configuration
- Memory browser and direct authoring flow
- Contributor sessions extract/review/submit flow
- Billing and profile pages (including public profile pages)
- Reports UI
- Chain-submit workflow
- Denial-batch submission panel
- Playwright end-to-end test suite

Current alpha caveat:

- Identity is still derived from wallet signature flows; passkey-first identity is not yet the default path

## Near-term

- Migrate to passkey-first identity
- Replace the single risk-appetite control with explicit content-filter and injection-gate toggles
- Add the leader report-response interface
- Add a “secure your earnings” prompt once a balance accrues

## Future

- Continue refining contributor, moderation, and governance UX for broader public rollout
- Expand onboarding clarity and safety defaults as identity and policy controls mature

## Design references

- https://github.com/WeVibe-Network/wevibe-docs
