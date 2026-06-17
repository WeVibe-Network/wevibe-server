# WeVibe Infra PDP

> **Status — ASPIRATIONAL / FUTURE-STATE:** This document describes target-state infrastructure. The current alpha deployment runs via Docker Compose (`wevibe-server/docker-compose.yml`); see `wevibe-server/README.md`.

## Stack

- **Orchestration:** Kubernetes (EKS/GKE/AKS) or Nomad.
- **IaC:** Terraform modules (TBD) per environment (dev/stage/prod).
- **Configuration:** Helm charts / Kustomize overlays per service.

## Components & Helm Charts

| Chart | Source | Description |
|-------|--------|-------------|
| `qdrant` | upstream helm repo | Vector DB with persistent volumes (NVMe recommended). |
| `ollama` | custom helm chart | GPU-enabled deployment, model cache PVC. |
| `postgres` | Bitnami chart | Primary + read replicas; uses AWS RDS/Aurora optionally. |
| `minio` | MinIO helm chart | Provides S3-compatible object store. |
| `wevibe-hub` | internal chart | Deploys hub API pods + ingestion workers. |
| `prom-stack` | kube-prometheus-stack | Monitoring. |

## Secrets Management

- Vault KV v2 or AWS Secrets Manager.
- Secrets injected via CSI driver; never mounted as plain env vars when avoidable.
- Rotations orchestrated through Argo Workflows (TBD).

## Networking

- Private subnets for stateful services.
- Public ingress (ALB/Nginx) terminates TLS and forwards to hub.
- Service mesh (Linkerd/Istio) optional for mTLS and retries.

## CI/CD

- GitHub Actions pipeline:
  1. Terraform plan/apply with manual approval.
  2. Build & push Docker images to GHCR.
  3. Helm deploy via Argo CD.
- Environment promotion triggered through Git tags (`infra/vX.Y.Z`).

## Observability

- Prometheus scrap configs for Qdrant, Hub, Ollama, Postgres exporter.
- Grafana dashboards: retrieval latency, serve ingest lag, DB health.
- Loki collects logs; Alertmanager routes critical alerts to PagerDuty.

## DR & Backups

- Postgres: AWS RDS snapshots + WAL archiving.
- Qdrant: nightly snapshots stored in object store.
- MinIO: versioning + replication to secondary region.
- Runbooks stored in `runbooks/` (to be authored).

## Outstanding Tasks

- Formalize Terraform modules.
- Add compliance documentation (SOC2, GDPR baseline).
- Build chaos experiments for vector DB and hub failover.

## Sprint 24 Updates

- Helm values and Terraform vars require new migrations for `approval_votes` and the `required_approvals` column in hub’s Postgres schema.
- Added ingress and RBAC notes for `/moderation/{submissionHash}/vote` and `/orgs/{orgID}/config` endpoints used by dashboards and plugins.
- Monitoring checklist now includes quorum attainment metrics and report queue depth exported by hub.
