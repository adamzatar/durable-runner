# Phase 3 Cloud Verification

Verified: 2026-09-26/27
Region: us-east-1

## Source and image

Git commit:

e7b81d6f2479cef215f9dc89b8ede689c96c552c

ECR image:

027660637185.dkr.ecr.us-east-1.amazonaws.com/durable-runner:e7b81d6f2479cef215f9dc89b8ede689c96c552c

Verified image digest:

sha256:0e7c6715e53b63e4042d1e3c4bd1b35ee523cb4de42dcc68cd01dd29f4f7b3dd

The API, worker, and coordinator Fargate tasks were independently
verified as RUNNING with this exact tag and digest.

## AWS deployment

Long-running ECS/Fargate services:

- API: desired 1, running 1
- worker: desired 1, running 1
- coordinator: desired 1, running 1

The API is exposed through an Application Load Balancer.
Worker and coordinator are not attached to the ALB.

PostgreSQL remains on private RDS subnets and is reachable only
through the intended security-group paths.

## Runtime verification

Verified:

- `GET /api/health/live` -> HTTP 200
- `GET /api/health/ready` -> HTTP 200 with `{"status":"ok","db":"ok"}`
- ALB target health -> healthy
- `GET /` -> HTTP 200 and serves the Durable Runner frontend
- `GET /api/events` -> HTTP 200
- SSE `/api/events/stream` opened successfully through the ALB and emitted keepalives
- CloudWatch logs showed API startup, worker registration, and coordinator startup
- Terraform converged to `No changes`

The readiness check provides application-level evidence that the
long-running API task successfully connected to the private RDS database.

## Important limitations

- The ALB currently exposes HTTP rather than HTTPS.
- This is a development/evidence deployment, not a production claim.
- Cloud-scale throughput has not yet been benchmarked.
- CI/CD and application observability beyond logs are still pending.
