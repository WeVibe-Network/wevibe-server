# WeVibe Dashboard PDP

## Technology Stack (target)

- Next.js 14 (app router) + TypeScript.
- TailwindCSS for styling, Radix UI primitives for modals/menus.
- Zustand or Redux Toolkit for client state.
- `@tanstack/react-query` for data fetching/caching.
- Wallet connector abstraction (initially in-browser ed25519 keys, upgradeable to Solana/EVM adapters).

## API Dependencies

- wevibe-hub REST (moderation queue, analytics, contest status).
- wevibe-hub WebSocket (real-time updates for queue / serve metrics).
- `protocol/` generated clients for memory/contest relationships.

## Pages & Features

| Route | Description |
|-------|-------------|
| `/` | Org landing + recent activity. |
| `/orgs/{id}/moderation` | Pending approvals with guard findings, relationship suggestions, lifecycle actions. |
| `/orgs/{id}/members` | Invite/remove members, role management, rotation state. |
| `/orgs/{id}/epoch` | Anchor manifest upload, rotation status, contest window controls. |
| `/orgs/{id}/stats` | Serve counts, confidence distribution, treasury burn. |
| `/discover` | Public org registry + keyword filter. |

## Component Architecture

- `components/ModerationCard` — renders guard results, lifecycle info, actions.
- `components/LifecyclePanel` — archive, relate, validity controls.
- `components/TreasuryWidget` — shows treasury balance + funding actions (link to wallet).
- `hooks/useHubStream` — wraps WebSocket updates.
- `stores/sessionStore` — holds authenticated member info, keys, session tokens.

## State & Storage

- IndexedDB storage via `idb` library for encrypted session cache (ciphertext only).
- `localStorage` fallback for seed phrase (MVP; flagged for removal post-wallet integration).

## Testing Strategy

- Unit tests with Jest + React Testing Library.
- Cypress E2E hitting mock hub server.
- Storybook snapshots for UI components.

## Deployment

- Vercel (default) with environment secrets for hub endpoints.
- Railway/Render fallback for self-hosting.
- CI pipeline: lint → type-check → unit tests → e2e (preview env) → deploy.

## Risks / Open Items

- Replace local key storage with hardware wallet integration.
- Implement role-based access control (moderator vs leader vs viewer).
- Accessibility audits pending.

## Sprint 24 Updates

- Added `/reports` queue page, including escalation votes sourced from hub `approval_votes` and report lifecycle actions.
- Settings page now persists `required_approvals` via the new hub configuration endpoint, requiring additional react-query mutations and optimistic state handling.
- Dashboard consumes the Accept / Deny / Report actions emitted by OpenCode, updating local cache and invalidating report queries on resolution.
