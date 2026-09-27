You are the autonomous implementation agent for Durable Runner Phase 3.

Before doing anything, read:

- `CLAUDE.md`
- `.agent/RULES.md`
- `.agent/PLAN.md`
- `.agent/STATE.md`
- `.agent/REVIEW.md`
- the existing Terraform and application code relevant to the current task

## Objective

Complete all locally reversible preparation for the long-running AWS deployment of Durable Runner, without performing external AWS mutations.

The intended deployed architecture is:

- one ECS/Fargate API service
- one ECS/Fargate worker service
- one ECS/Fargate coordinator service
- Application Load Balancer in front of the API only
- private RDS PostgreSQL remains the coordination/database layer
- API uses the API security group
- worker and coordinator use the backend security group
- PostgreSQL remains private
- no NAT Gateway unless a concrete technical requirement proves it necessary
- no Kubernetes, Kafka, Redis, service mesh, multi-region, RDS Proxy, or unrelated infrastructure

## First close Phase 2D documentation

Before Phase 3 implementation, update project documentation and the evidence ledger so the repository accurately records the now-observed Phase 2D facts:

- immutable Git-SHA image successfully pushed to ECR
- real Fargate migration tasks successfully pulled and ran that image
- Secrets Manager `password` key injection works
- Fargate reached private RDS through the intended SG path
- real RDS TLS hostname and CA verification succeeded
- PostgreSQL 16.13 was reached over TLSv1.3
- all expected schema tables exist
- all 7 Drizzle migrations are present and applied
- deliberate later migration rerun exited 0
- Terraform converged with no changes
- no secret value was manually retrieved or emitted

Do not call this a production deployment.

## Phase 3 implementation work

Work through the corresponding unchecked items in `.agent/PLAN.md`.

Design and implement, where justified:

- API ECS task definition and service
- worker ECS task definition and service
- coordinator ECS task definition and service
- ALB and target group for API
- listener and security-group wiring
- ECS health checks and ALB health checks
- deployment/draining configuration
- independent desired counts
- CloudWatch log streams/prefixes
- appropriate CPU/memory settings
- task-definition commands using the existing single image
- database environment configuration using the existing cloud DB config
- secret injection without exposing credentials
- long-running credential-rotation behavior
- outputs needed for later verification

Preserve the existing security model.

## Credential rotation requirement

The RDS-managed password rotates every 7 days.

ECS secret environment variables are resolved when a task starts, so long-running processes cannot silently assume an injected password will remain valid forever.

Analyze this concretely and implement the simplest defensible design for this project.

Prefer a small operationally clear solution over adding infrastructure for prestige.

Do not introduce RDS Proxy unless evidence shows it is necessary.

Document the tradeoff and how replacement tasks acquire current credentials.

## Autonomous permissions

You may:

- inspect and edit repository files
- edit TypeScript
- edit tests
- edit Terraform
- edit documentation
- update `.agent/PLAN.md`, `.agent/STATE.md`, and `.agent/REVIEW.md`
- run local tests
- run typecheck/build
- run local Docker builds/inspection
- run `terraform fmt`
- run `terraform validate`
- run `terraform plan`
- inspect Git history/diffs/status
- research official documentation where needed
- diagnose and fix failures
- repeat locally reversible work until acceptance criteria pass

## Hard stop

DO NOT:

- run `terraform apply`
- run `terraform destroy`
- mutate AWS resources
- push images to ECR
- create or update ECS services in AWS
- create an ALB in AWS
- modify security groups in AWS
- manually retrieve secret values
- change IAM in AWS
- git push
- force/reset Git
- delete user work
- weaken TLS
- expose RDS publicly
- open port 5432 publicly
- bypass failing tests

Do not use `--target` as a shortcut for ordinary Terraform lifecycle management.

Do not commit unless explicitly allowed by RULES.md.

## Working loop

For each iteration:

1. Re-read PLAN, STATE, RULES and REVIEW.
2. Inspect actual repository state rather than relying on assumptions.
3. Pick the earliest useful unfinished Phase 3 criterion that is not blocked by a human gate.
4. Implement it fully.
5. Run narrow validation while developing.
6. Run broader validation before declaring it complete.
7. Fix failures at their root cause.
8. Update STATE with evidence actually observed.
9. Tick PLAN items only when supported by evidence.
10. Continue automatically to the next unblocked item.

Do not stop merely because one subtask is finished.

## Independent self-review pass

Before reaching the human gate, perform a separate adversarial review of the complete Phase 3 diff.

Review specifically for:

- task-definition correctness
- API/worker/coordinator command correctness
- ALB routing
- readiness/liveness behavior
- graceful shutdown/draining
- networking
- SG directionality
- IAM least privilege
- secret handling
- credential rotation
- Terraform dependency mistakes
- cost surprises
- accidental always-on or unnecessary resources
- ARM64 compatibility
- mismatch between image/runtime assumptions and repository reality

Resolve concrete findings and rerun validation.

## Required final validation

Before stopping:

- full test suite passes
- typecheck passes
- production build passes
- `git diff --check` passes
- `terraform fmt -check -recursive` passes
- `terraform validate` passes
- real Terraform plan using the intended image SHA succeeds
- plan contains no unexplained destroy or replacement
- plan matches the intended architecture
- no secrets appear in plan output
- documentation matches actual evidence

## Human gate

When the next external AWS mutation is the only sensible next action:

Create `.agent/HUMAN_GATE.md`.

It must contain:

- what was implemented
- test/build results
- Terraform plan summary
- exact resources to add/change/destroy
- IAM changes
- networking/security changes
- expected monthly/run cost
- credential-rotation design
- unresolved risks
- exact command awaiting approval

Then STOP.

Do not perform the mutation.

If an architectural ambiguity or blocker cannot be responsibly resolved from the repository and authoritative documentation, create `.agent/BLOCKED.md` explaining it and STOP.

Do not create HUMAN_GATE merely because an intermediate implementation step completed. Continue until all reasonable locally reversible Phase 3 preparation is finished.
