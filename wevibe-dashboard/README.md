# wevibe-dashboard

Moderation and org management web application.
Consumes the wevibe-hub HTTP API only — no direct database access.

## Key surfaces

- `/orgs/{org_id}/moderation` — moderator review queue
- `/orgs/{org_id}/members` — member management (leader only)
- `/orgs/{org_id}/epoch` — epoch rotation controls (leader only)
- `/orgs/{org_id}/stats` — org analytics
- `/discover` — public org registry

## Stack (TBD)

Recommended: Next.js + TypeScript, deployed on Vercel or Railway.
Wallet connection via Solana wallet adapter (for future on-chain identity).
For Phase I, identity is Ed25519 keypair in browser localStorage (acceptable for MVP).

## Build

TODO: initialize Next.js project here
