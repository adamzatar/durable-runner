# Resume evidence ledger

What can honestly be claimed about this project, and what backs it. A claim
counts as verified only when the evidence exists and has been checked. When
a phase adds evidence, update the row rather than rewording the claim
upward.

## CI/CD verification

[GitHub Actions run 37248771108][ci] verified commit
`5f74e0e55acb9465d50ecd6f4c763a175372e0c4` on **2026-10-04 EDT /
2026-10-05 UTC**: **244 passing tests across 22 test files**, successful
typechecking, database migrations and production build. The environment was
Ubuntu 24.04.5, Node.js 24.21.0, npm 11.19.0, Vitest 3.2.7 and PostgreSQL
16.15. The suite includes real PostgreSQL integration tests, configuration
tests, connection/TLS failure simulations and process-lifecycle tests.
These results apply to that commit and CI environment.

The same run authenticated to AWS through GitHub OIDC, published an ARM64
image under the immutable full Git-SHA tag, ran migrations through an ECS
task, deployed separate API, worker and coordinator Fargate services, checked
their running-image digests and passed API liveness, readiness and events
smoke checks. The ECR image and all three services matched:

`sha256:4f9d9724999983f2414540367974bf2d7e3755c01338410a253661b028699591`

## AWS observation: 2026-11-08

Authenticated AWS CLI output supplied to the engineering controller on
2026-11-08 confirmed API, worker and coordinator services each at desired 1,
running 1, on task-definition revision `:2`. All three running containers
matched the deployment digest above. RDS was `available`, private and
`db.t4g.micro`; the ALB was active, and API readiness returned
`{"status":"ok","db":"ok"}`. The experiment-only task definition
`durable-runner-dev-worker-phase5:1` was active, ARM64 Linux, with the expected
image and `stopTimeout=2`. These observations describe the deployment on
that date.

The AWS application stack was subsequently torn down to avoid ongoing
costs. The portfolio demo runs locally. Historical deployment evidence
below is retained with its verification dates.

## Claims

| Claim | Evidence | Verified? | Resume-safe wording |
|---|---|---|---|
| Built a PostgreSQL-backed durable task runtime with leases, fencing, retries, dead-lettering and idempotent effects | Source in `server/src`; 244 tests across 22 files passed at the exact commit and date recorded in [CI/CD verification](#cicd-verification) | **Yes** | "Built a TypeScript/PostgreSQL durable task runtime with lease-based ownership, fencing tokens, bounded retries and dead-lettering" |
| Throughput and correctness under load | [Approved local benchmark](../benchmarks/results/2026-09-19T01-14-28-972Z_3cbb858.md): 3,277.1 tasks/s median with 8 workers, zero duplicate ownership grants across 200,266 claims, 4,750 rejected stale writes and zero duplicate logical effects across 45,000 executions | **Yes**, local machine (Apple M2, Node 20.19.4, PostgreSQL 16.15) | "Benchmarked at ~3.3k tasks/s across 8 worker processes on one machine, with zero duplicate ownership grants across 200k claims" |
| Runs on Node.js 24 | Node 24.21.0: `npm ci`, typecheck, build, full test suite, compiled API/worker/coordinator smoke tests | **Yes** | Not a résumé bullet on its own |
| Containerized with Docker | `Dockerfile` (multi-stage, non-root, one image for all roles), committed. The 2026-09-26 migration image was built for linux/arm64 from `git archive` of commit `4993cf9`. API, worker and coordinator Fargate tasks were subsequently verified in [Phase 3](phase3-cloud-verification.md) and at `5f74e0e…` by [CI/CD][ci] | **Yes** | "Packaged the runtime as a single multi-stage, non-root Docker image serving API, worker, coordinator and migration roles" |
| Authored Terraform for AWS networking, security groups, ECR and budget alerts | `infra/*.tf`; `terraform fmt -check`, `terraform init`, `terraform validate` pass; real `terraform plan` against the personal AWS account (us-east-1), audited resource by resource | **Yes** | Covered by the provisioning row below |
| Provisioned AWS infrastructure with Terraform | 2026-09-24: `terraform apply` of the reviewed saved plan (29 added, 0 changed, 0 destroyed). Result checked independently with the AWS CLI, then an immediate re-plan reported "No changes". That checkpoint covered the network and ECR; later RDS and service deployment evidence appears below | **Yes**, with dated evidence for each layer | "Provisioned an AWS VPC foundation with Terraform: two-AZ public and private subnets, internet-gateway routing, and security groups that admit traffic only from specific other groups (ALB to API on 3000, API and workers to PostgreSQL on 5432)" |
| Deployed and verified an AWS VPC | 2026-09-24: VPC `10.0.0.0/16` with DNS on; 4 subnets across `us-east-1a`/`us-east-1b`, none auto-assigning public IPs; IGW attached; public table routes `0.0.0.0/0` to the IGW; private-DB table has local routes only; 9 security-group rules matching the design (no public 3000/5432, backend has no ingress, rds has no egress, default group emptied); all checked with `aws ec2 describe-*`. Subsequent [Phase 3](phase3-cloud-verification.md) checks verified application traffic through the ALB and API-to-RDS readiness | **Yes**, network and subsequent application deployment | Same provisioning bullet as above |
| Provisioned Amazon ECR | Private repository `durable-runner`: immutable tags, scan on push, AES256, untagged images expire after 14 days; checked with `aws ecr`. Image publication and runtime digest verification are recorded below | **Yes** | "Provisioned a private ECR repository with immutable tags and scan-on-push" |
| Pushed images to / deployed from ECR | 2026-09-26: image tagged with the full Git SHA `4993cf9d…`; ECR digest `sha256:acad2e45…` equaled the local manifest digest and was pulled by one-off tasks. [CI/CD][ci] subsequently published `5f74e0e…` and verified the full digest recorded above in all three services; supplied 2026-11-08 output confirmed the same running digest | **Yes**, immutable SHA-tagged ARM64 images and running-service provenance | "Built and pushed immutable, Git-SHA-tagged ARM64 images to ECR and verified running ECS containers against their image digest" |
| Project-scoped AWS cost budget | 2026-09-25: `Project` cost allocation tag activated; Terraform-managed monthly $50 budget filtered to `Project=durable-runner-dev` with $20 actual, $50 forecast and $50 actual email alerts; checked with `aws budgets`, then a re-plan reported no changes | **Yes** | Not a bullet on its own; supports the provisioning row as evidence of cost controls on the deployed AWS project |
| Provisioned private RDS PostgreSQL with Terraform | 2026-09-25: saved, reviewed plan applied (2 added, 0 changed, 0 destroyed). `aws rds`/`aws ec2` show PostgreSQL 16.13, db.t4g.micro, single-AZ, encrypted gp3, not publicly accessible, private IP only, in the private DB subnets, only the rds security group (5432 from api/backend groups only), RDS-managed rotating secret with no password in Terraform state; re-plan reported no changes; `enable_database = false` plan destroys only the instance | **Yes**: provisioning and private, encrypted placement | "Provisioned a private, encrypted Amazon RDS PostgreSQL instance with Terraform, with RDS-managed rotating credentials and access restricted by security-group reference" |
| Application connects to RDS / migrations ran on RDS | 2026-09-26: Terraform-defined Fargate migration task (ARM64) ran three times, exit 0 each; the password came from the RDS-managed secret's `password` key via ECS secret injection, never read by a person. A read-only diagnostic task, using the app's own connection code, observed TLSv1.3 with CA and hostname verification against the packaged RDS CA bundle, PostgreSQL 16.13, all expected tables, and 7 applied migrations matching the 7 packaged files by hash. Re-running migrations exited 0. Re-plan: "No changes". Logs reviewed: no secret material. Later [Phase 3](phase3-cloud-verification.md), [CI/CD][ci] and the supplied 2026-11-08 observation verified long-running API-to-RDS readiness; CI/CD migrations also succeeded | **Yes**, one-off tasks and long-running API connectivity | "Ran schema migrations on private RDS PostgreSQL from ECS Fargate over certificate- and hostname-verified TLS, with the database password injected from Secrets Manager at task start" |
| Long-running services on ECS Fargate / behind an ALB | `infra/services.tf`; [Phase 3](phase3-cloud-verification.md), verified 2026-09-26/27; later [CI/CD rollout][ci]. Supplied 2026-11-08 output confirmed all three services at 1/1 on revision `:2`, matching the deployment digest, private RDS available and the ALB active | **Yes**, at the recorded checkpoints | "Deployed separate API, worker and coordinator services on ECS Fargate, with the API behind an ALB and PostgreSQL on private RDS" |
| CI/CD | `.github/workflows/deploy.yml` and `.github/scripts/deploy-ecs.sh`; [successful run][ci] on 2026-10-04 EDT / 2026-10-05 UTC: verification, GitHub OIDC, ARM64 ECR publication, ECS migrations and rollout, running-image digest checks and API smoke tests | **Yes** | "Automated verification and ECS deployment with GitHub Actions and AWS OIDC, including database migrations, image provenance checks and API smoke tests" |
| CloudWatch logging | [Phase 3](phase3-cloud-verification.md): API startup, worker registration and coordinator startup observed in CloudWatch logs; task definitions write to `/ecs/durable-runner-dev` | **Yes**, application logs | "Configured CloudWatch logging for ECS application services" |
| Application observability beyond logs | No supporting verification recorded | **No** | none |
| Cloud throughput benchmarks | Reported throughput and concurrency results were measured locally on an Apple M2, not AWS | **No** | Use the explicitly local benchmark wording above |
| Production readiness | Development/evidence deployment; CI/CD and smoke checks do not establish production readiness | **No** | none |

## Final experiment scope

Real-process local crash recovery has been demonstrated: the
[build journal](build-journal.md#2026-09-17--milestone-5-final-recovery-cleanup)
records a successful SIGKILL demo, recovery after the original lease deadline,
and another worker completing at generation 2. Ordinary AWS deployment and
GitHub Actions CI/CD have also been verified.

The supplied 2026-11-08 AWS output verified the experiment-only task
definition `durable-runner-dev-worker-phase5:1` with ARM64 Linux, the expected
image and a two-second stop timeout. The evidence stops at task-definition
registration. Phase 5 (controlled Fargate crash recovery) and Phase 6
(cloud benchmarking) were omitted. Further AWS experiments are outside
the completed portfolio scope.

Things never to claim for this project: exactly-once execution,
production-grade or globally distributed validation. Fencing protects
authoritative internal state; idempotent logical effects are demonstrated
only in the controlled PostgreSQL effect sink. The local benchmarks,
deployed AWS services and CI/CD are supported by dated evidence above;
cloud throughput and production readiness remain unverified.

[ci]: https://github.com/adamzatar/durable-runner/actions/runs/37248771108
