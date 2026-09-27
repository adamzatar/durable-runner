# Durable Runner — Current State

Last updated: 2026-09-26. Only evidence actually observed is recorded here.
Evidence levels: planned / Terraform-defined / deployed / control-plane
verified / runtime verified / benchmarked.

## Position in PLAN.md

Phase 2D (real Fargate migration proof) is **complete**. Stopped before
"Long-running ECS services". No ECS service, ALB, task role or new
networking exists.

Note: the image push, `terraform apply` and the three migration task runs
happened outside the agent session that wrote this file. They are recorded
below from what AWS reports (ECR, ECS task records, CloudWatch logs), not
from having watched them run.

## Source

- HEAD: `4993cf9d54d2066a500a479a78095d5b32496fe5`
  ("Add cloud database config and ECS migration task").
- Tracked files identical to HEAD; only `.agent/` is untracked.

## Local validation (Node 24.21.0, 2026-09-26)

- typecheck, build, `git diff --check HEAD`, `terraform fmt -check`,
  `terraform validate`: pass
- `npm test`: 21 files / 238 tests pass

## Image

- Built locally from `git archive HEAD`, `--platform linux/arm64
  --provenance=false --sbom=false`, label
  `org.opencontainers.image.revision=<SHA>`.
- ECR (observed): `durable-runner:4993cf9d54d2066a500a479a78095d5b32496fe5`,
  digest `sha256:acad2e45f65a0848287c940e2d0e1db07604aec245356300824595c5eb5731da`
  (identical to the local manifest digest), OCI image manifest,
  87,307,423 bytes, pushed 2026-09-26T19:56:50-04:00. The only image in the
  repository.
- Config: linux/arm64, user `node` (uid 1000), Node v24.21.0. CA bundle
  SHA-256 `e5bb2084…c7e3` matches the repo; 7 migrations packaged.

## Deployed and control-plane verified (2026-09-26)

- ECS cluster `durable-runner-dev`: ACTIVE, 0 services, 0 running tasks.
- Task definition `durable-runner-dev-migrate:1`: ACTIVE, Fargate ARM64,
  256 CPU / 512 MiB, image `repo:<SHA>`, execution role
  `durable-runner-dev-ecs-execution`, **no task role**, one secret
  (`DB_PASSWORD`).
- Execution role: 0 managed policies; inline `image-pull-and-logs`
  (ecr:GetAuthorizationToken on `*`; BatchGetImage/GetDownloadUrlForLayer on
  `repository/durable-runner`; CreateLogStream/PutLogEvents on
  `/ecs/durable-runner-dev` and its streams) and `read-rds-master-secret`
  (secretsmanager:GetSecretValue on `rds!db-c5490763-…-31WqkU` only).
- Log group `/ecs/durable-runner-dev`, retention 7 days.
- `terraform plan -var image_tag=<SHA> -detailed-exitcode`: exit 0,
  "No changes". The saved `infra/phase-2d-<SHA>.tfplan` is now stale.

## Runtime verified (2026-09-26)

Migration tasks (task definition `:1`, default command, no overrides beyond
the container name), all image digest `sha256:acad2e45…`, arm64, platform
1.4.0, exit 0, stopCode EssentialContainerExited, log output exactly
"Migrations applied.":

| Task | Created (-04:00) | Subnet / private IP |
|---|---|---|
| `52c3df3a3e1944b6a5d5a8c408f26928` | 20:00:37 | public-a / 10.0.0.145 |
| `49d83593c452421d8c559a6788bf8ed0` | 20:00:59 | public-b / 10.0.1.216 |
| `61c10530d61441bcb3ccaa385a535143` | 20:07:47 | public-a / 10.0.0.203 |

Read-only schema diagnostic (run by the agent, approved):

- Task `arn:aws:ecs:us-east-1:027660637185:task/durable-runner-dev/e4b1cee2ef784b6e9a410d13e7df033f`,
  started-by `phase-2d-schema-check`, task definition `:1`, override =
  container command only (no environment overrides), backend SG, public
  subnets, assignPublicIp ENABLED. Ran in public-a (10.0.0.180),
  20:18:31–20:18:59 -04:00. **Exit code 0.**
- Connected through the app's own compiled `resolveDbConnectionConfig()` +
  `createDbPool()` (cloud DB_* path, packaged CA), with session parameter
  `default_transaction_read_only=on` (observed `on`). SQL: 5 SELECTs only.
- Client-side TLS: `authorized: true`, TLSv1.3, servername = the RDS
  endpoint; peer certificate CN/SAN =
  `durable-runner-dev.cw1mm8ie0o3a.us-east-1.rds.amazonaws.com`, issuer
  `Amazon RDS us-east-1 Subordinate CA RSA2048 G1.A.10`, valid to
  2027-09-25.
- Server-side `pg_stat_ssl` for `pg_backend_pid()` (23092): ssl = true,
  TLSv1.3, TLS_AES_256_GCM_SHA384, 256 bits.
- `current_database()` = `durable_runner`; user `durable_runner_admin`;
  server version 16.13 (aarch64-unknown-linux-gnu).
- Tables: `drizzle.__drizzle_migrations`, `public.idempotent_effects`,
  `public.spike_events`, `public.step_events`, `public.steps`,
  `public.workers`.
- `drizzle.__drizzle_migrations` exists with **7 rows** (ids 1–7). Every row
  matches a journal entry packaged in the image by `when` timestamp and
  SHA-256 of the migration file (0000_amusing_quentin_quire …
  0006_tired_golden_guardian), and there are exactly 7 journal entries.

What this proves at runtime: Fargate (ARM64) pulled the SHA image from
private ECR; the execution role injected `DB_PASSWORD` from the RDS-managed
secret's `password` JSON key (password authentication as
`durable_runner_admin` succeeded; no other password source exists in the
task definition or image); the task reached private RDS on 5432 through the
backend -> rds security-group path; TLS verified against the packaged RDS CA
bundle with hostname match; migrations are applied and re-running them is a
no-op that exits 0.

## Secret handling evidence

- The Secrets Manager value was never read by the agent.
- All 4 log streams in `/ecs/durable-runner-dev` reviewed in full: 11 lines
  total (3 × "Migrations applied.", 8 diagnostic JSON lines); none contains
  "passw", "secret" or a `postgres://` URL.

## Still open (next phase, not started)

- Secret rotation (every 7 days; next 2026-10-02) vs long-running tasks
  that receive the password once at start.
- API/worker/coordinator task definitions and services, ALB: none exist.
- RDS keeps running (~$0.47/day) while `enable_database = true`.
