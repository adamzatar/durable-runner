# Durable Runner Agent Rules

## Purpose

These rules govern autonomous coding-agent work on Durable Runner.

The agent may perform local, reversible engineering work independently.

External mutations, destructive operations, and security-sensitive deployment actions require human approval.

---

## Autonomously allowed

The agent may:

- inspect repository files and Git history
- edit application source code
- edit tests
- edit Docker configuration
- edit Terraform source
- edit documentation
- edit files under `.agent/`
- run typechecking
- run tests
- run builds
- run local Docker builds and containers
- run database migrations against the established local test database
- run `terraform fmt`
- run `terraform validate`
- run `terraform plan`
- use read-only AWS CLI commands
- inspect AWS resource configuration
- inspect CloudWatch logs after an approved deployment
- diagnose failures
- fix local implementation problems
- rerun validation until acceptance criteria pass

---

## Human approval required

STOP before performing any of the following:

- `terraform apply`
- `terraform destroy`
- AWS resource creation, modification, or deletion outside an explicitly approved action
- pushing an image to ECR
- changing security-group ingress
- making RDS publicly accessible
- creating a public endpoint
- materially expanding IAM permissions beyond an already reviewed plan
- retrieving or printing secret values
- deleting cloud resources
- `git push`
- force push
- destructive Git reset
- deleting uncommitted user work
- rewriting Git history
- committing unless explicitly instructed to do so

When reaching one of these gates, report the exact proposed mutation and stop.

---

## Never

Never:

- weaken TLS verification to make a connection succeed
- use `rejectUnauthorized: false`
- use an insecure/no-verify SSL mode
- expose PostgreSQL port 5432 to `0.0.0.0/0` or `::/0`
- make the private RDS instance public for convenience
- put passwords or secret values in source code
- put passwords in Terraform configuration
- put credential-bearing database URLs in Terraform
- log database passwords
- log secret JSON
- bypass or delete failing tests merely to obtain a green run
- silently reduce test coverage
- rewrite historical benchmark results
- claim evidence that was not actually observed
- describe Durable Runner as exactly-once execution
- describe a personal cloud deployment as production
- add Kubernetes, Kafka, Redis, service mesh, multi-region, or other major infrastructure without an explicit project decision

---

## Evidence rules

Claims must reflect actual observed evidence.

Distinguish:

- planned
- Terraform-defined
- deployed
- control-plane verified
- runtime verified
- benchmarked

Do not promote a claim to a stronger category without evidence.

The system provides at-least-once execution.

Historical local benchmark results remain separate from future cloud benchmark results.

---

## AWS boundaries

Use:

- profile: `durable-runner`
- region: `us-east-1`
- account: `027660637185`

Do not use other AWS profiles for Durable Runner.

The project uses cost-conscious infrastructure.

Avoid introducing:

- NAT Gateway
- Multi-AZ RDS
- RDS Proxy
- paid observability features
- unnecessary always-on compute

unless a concrete requirement justifies them.

---

## Git/image provenance

Any image tagged with a Git SHA must be built from source corresponding exactly to that commit.

Do not tag a dirty-tree build with `HEAD`.

If image-affecting files differ from `HEAD`, stop before producing the canonical ECR image.
