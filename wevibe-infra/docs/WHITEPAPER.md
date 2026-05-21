# WeVibe Infra Whitepaper

Version: 0.3 · Sprint 24

## Goals

WeVibe Infra describes the reference deployment for shared services operated by the WeVibe team or third parties: vector search, LLM extraction, hub API, and supporting databases. While orgs can self-host, this blueprint ensures consistent reliability for hosted offerings.

## Core Services

| Service | Purpose | Notes |
|---------|---------|-------|
| Qdrant | Vector search for moderation analytics and discovery | Stores encrypted embeddings. |
| Ollama | Runs embedding + extraction models | Hosts organization-specific prompt packs. |
| PostgreSQL | Stores org/member metadata, receipts, contest audit logs | All sensitive blobs encrypted-at-rest. |
| Object Storage (S3 compatible) | Backup storage for encrypted blobs and guard artifacts | Server-side encryption required. |
| wevibe-hub | API + ingestion service | Deployed alongside infra stack. |

## Security Posture

- All services deployed inside a private VPC; public ingress only through API gateway / load balancer.
- Secrets managed via Vault or AWS Secrets Manager; no plaintext in repo.
- TLS termination at ingress; internal traffic uses mTLS where supported (Hub ↔ Qdrant/Postgres).
- Access logs shipped to centralized logging (CloudWatch/Loki).

## Compliance Considerations

- PII stored only if org opts in (e.g., billing). Stripe secret key used solely for billing API.
- Memory blobs remain ciphertext end-to-end; infra never sees plaintext.
- Ops runbooks require dual-approval for key rotations and secret updates.

## Scalability

- Qdrant deployed with horizontal shard/replica settings; autoscaling based on recall latency.
- Ollama uses GPU-enabled nodes; autoscale on GPU utilization.
- PostgreSQL uses read replicas for analytics workloads (Grafana dashboards, etc.).
- Hub pods scale via Kubernetes HPA (CPU + request latency).

## Observability

- Prometheus + Grafana for metrics.
- Loki / Elastic for logs.
- Tempo / Jaeger for traces (hub + ingestion).
- Uptime checks via synthetic monitors.

## Disaster Recovery

- Nightly encrypted backups (PostgreSQL logical dump, Qdrant snapshot, S3 versioning).
- Runbook for hub failover to secondary region.
- Chaos testing plan to validate failover monthly.

## Future Enhancements

- Terraform modules for AWS/GCP/Azure parity.
- Automated certificate rotation via Cert-Manager + ACME.
- Policy-as-code (OPA) for network segmentation checks.

## Sprint 24 Updates

- Infrastructure blueprints now include storage for hub `required_approvals` and moderator vote tables, plus backups covering the new approval workflow data.
- API gateway configuration references the `/moderation/{submissionHash}/vote` and `/orgs/{orgID}/config` routes that enable hub-side quorum enforcement.
- Observability dashboards were extended to track report queue depth and quorum attainment rates so operators can monitor the refreshed moderation lifecycle.
