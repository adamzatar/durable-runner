# Durable Runner Completion Plan

## Completed

- [x] Core durable task execution runtime
- [x] PostgreSQL concurrent claiming with `FOR UPDATE SKIP LOCKED`
- [x] Leased ownership
- [x] Generation fencing with `lease_version`
- [x] Crash recovery
- [x] Retry scheduling and dead-lettering
- [x] Worker heartbeat tracking
- [x] Idempotent side-effect handling
- [x] Durable lifecycle history
- [x] SSE event delivery
- [x] Event cursor correctness across commit-order races
- [x] Local correctness/concurrency testing
- [x] Local benchmark evidence
- [x] Node.js 24 support
- [x] Production Docker image
- [x] Liveness/readiness endpoints
- [x] Graceful API/worker/coordinator shutdown
- [x] Explicit PostgreSQL pool sizing
- [x] Shutdown-test process leak fixed
- [x] Terraform AWS network foundation
- [x] Private ECR repository
- [x] Project-scoped AWS Budget
- [x] Private encrypted RDS PostgreSQL
- [x] RDS-managed rotating credentials
- [x] Cost-safe `enable_database` lifecycle toggle
- [x] Cloud DB configuration path
- [x] RDS CA bundle packaged into the image
- [x] Strict RDS TLS hostname/certificate verification
- [x] Minimal ECS/Fargate migration Terraform prepared
- [x] Phase 2D preparation tests: 21 files / 238 tests

---

## Phase 2D: real Fargate migration proof

- [x] Confirm clean Git working tree
- [x] Record full committed Git SHA
- [x] Build production image from exact committed HEAD
- [x] Verify image is linux/arm64
- [x] Push Git-SHA-tagged image to private ECR
- [x] Record ECR image digest
- [x] Generate Terraform plan using the real Git SHA
- [x] Verify plan contains only expected ECS/IAM/logging resources
- [x] Human approval for Terraform apply
- [x] Apply minimal ECS migration infrastructure
- [x] Verify ECS cluster/task definition/IAM/logging resources
- [x] Run migration task #1
- [x] Confirm Secrets Manager JSON-key injection works
- [x] Confirm Fargate -> private RDS network connectivity
- [x] Confirm real RDS TLS verification succeeds
- [x] Confirm migration task #1 exits 0
- [x] Verify expected schema/migration state from inside AWS
- [x] Run migration task #2
- [x] Confirm migration task #2 exits 0
- [x] Confirm no secrets leaked to logs
- [x] Confirm Terraform returns no changes

---

## Long-running ECS services

- [ ] Design long-running credential-rotation behavior
- [ ] Create API ECS task definition/service
- [ ] Create worker ECS task definition/service
- [ ] Create coordinator ECS task definition/service
- [ ] Confirm independent desired counts
- [ ] Create/configure ALB
- [ ] Connect ALB to API service
- [ ] Configure liveness/readiness behavior
- [ ] Verify graceful draining/replacement
- [ ] Verify public application endpoint
- [ ] Verify API -> RDS
- [ ] Verify worker -> RDS
- [ ] Verify coordinator -> RDS
- [ ] Verify SSE through ALB

---

## CI/CD

- [ ] Add PR validation workflow
- [ ] Run install/typecheck/tests/build in CI
- [ ] Build Docker image in CI
- [ ] Configure GitHub OIDC for AWS
- [ ] Avoid long-lived AWS credentials
- [ ] Push immutable Git-SHA image
- [ ] Run migration-before-deploy workflow
- [ ] Deploy ECS services
- [ ] Wait for service stability
- [ ] Run smoke test
- [ ] Document rollback behavior

---

## Observability

- [ ] Define useful operational logs
- [ ] Add CloudWatch metrics where justified
- [ ] Create CloudWatch dashboard
- [ ] Create at least one meaningful alarm
- [ ] Verify alarm behavior
- [ ] Document investigation workflow

---

## Failure experiments

- [ ] Kill worker during execution
- [ ] Verify lease expiry/recovery/reclaim
- [ ] Kill coordinator and verify recovery behavior
- [ ] Replace API task and verify graceful drain
- [ ] Exercise retry/dead-letter behavior
- [ ] Exercise database interruption/recovery if practical
- [ ] Record observed evidence

---

## Cloud benchmark

- [ ] Define cloud benchmark methodology
- [ ] Record ECS task sizes
- [ ] Record RDS configuration
- [ ] Record region/AZ/network configuration
- [ ] Benchmark 1 worker
- [ ] Benchmark 2 workers
- [ ] Benchmark 4 workers
- [ ] Record throughput/latency
- [ ] Keep cloud results separate from historical local benchmark
- [ ] Document bottlenecks and engineering interpretation

---

## Finalization

- [ ] Finalize cloud architecture documentation
- [ ] Finalize deployment/runbook documentation
- [ ] Finalize resume evidence ledger
- [ ] Produce final conservative resume bullets
- [ ] Confirm public GitHub repository contains intended work
- [ ] Remove unnecessary billable AWS resources
- [ ] Preserve useful free AWS foundation if desired
- [ ] Final Terraform/state sanity check
- [ ] STOP adding features
