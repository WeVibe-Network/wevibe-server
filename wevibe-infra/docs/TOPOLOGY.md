# WeVibe Infra Topology

## Reference Architecture

```
                  +----------------------+
                  |    Cloud Load Balancer|
                  +-----------+----------+
                              |
                         Ingress/Nginx
                              |
         +--------------------+-------------------+
         |                                        |
   +-----v-----+                              +---v----+
   | wevibe-hub  |<----> Redis (pub/sub/cache)  | ArgoCD |
   +-----------+                              +--------+
         |
         | gRPC/REST
         v
+------------------+      +-------------------+
| PostgreSQL (RDS) |      | Qdrant Cluster    |
+------------------+      +-------------------+
         |                         |
         | backups                 | snapshots
         v                         v
   Object Store (MinIO/S3) <----> Backup bucket

GPU node group (Ollama) <---> Qdrant (for embeddings) + Object store
```

## Kubernetes Namespaces

- `core` — wevibe-hub, ingress, redis.
- `data` — postgres, qdrant, minio.
- `ml` — ollama deployments.
- `monitoring` — prometheus-stack, grafana, loki.
- `argo` — Argo CD / Workflows.

## Networking

- VPC with public + private subnets.
- NACLs restrict database and vector traffic to cluster nodes.
- Ingress exposes HTTPS (ACME certificates).
- Service mesh (optional) enforces mTLS between hub, redis, qdrant, postgres.

## Scaling

- HPA for hub API pods (CPU + P95 latency triggers).
- Redis cluster mode for high throughput.
- Qdrant horizontal shards (shard per org or dataset) with replica count based on QPS.
- Ollama autoscaling using GPU utilization metrics.

## Backup/Recovery Pipelines

- Nightly Argo Workflow runs: Postgres dump, Qdrant snapshot, MinIO replication.
- Restore runbooks document RPO < 1h and RTO < 2h targets.

## Monitoring & Alerting

- Prometheus scrapes exporters; Grafana dashboards summarise serve throughput, confidence decay anomalies, queue depth.
- Loki collects structured logs; alerts fired to PagerDuty/Slack via Alertmanager.

## Security

- Secrets injected via Vault/Secrets Manager.
- All storage encrypted at rest (AWS KMS / cloud provider keys).
- Access to kubectl restricted through SSO and RBAC.
- Regular vulnerability scans on container images via Trivy.

## Sprint 24 Notes

- Add Postgres migrations for the `approval_votes` table and `required_approvals` column; include them in Argo CD sync hooks.
- Ensure ingress routes forward the new moderation vote and org config endpoints used by dashboard and plugin flows.
- Extend monitoring dashboards with quorum attainment metrics and report queue depth emitted by hub.
