# The long-running roles: the API behind an internet-facing ALB, plus the
# worker and coordinator services. All three run the same SHA-tagged image
# as the migration task (ecs.tf), with a different command.
#
# Everything here exists only when enable_services is true, which requires
# the database and an image tag. The ALB bills by the hour whether or not
# any task runs, so the toggle removes it too. Desired counts are separate
# variables, so each role scales on its own, including to zero.
#
# Once deployed, each task runs in its own Fargate isolation boundary (its
# own kernel, CPU, memory and network interface), so the API, the workers
# and the coordinator are separate processes in separate tasks that share
# only PostgreSQL. Fargate doesn't say which physical hosts those are.
# Locally they are separate processes on one machine.
#
# Networking is the migration task's: public subnets with a public IP, used
# only to pull the image and ship logs (no NAT Gateway; see
# docs/cloud-architecture.md). The api group admits port 3000 from the alb
# group only; the backend group admits nothing. No security-group rule
# changes: security.tf already has exactly these flows.
#
# No task role on any task definition: the application makes no AWS API
# calls, so its containers get no AWS credentials. The execution role in
# ecs.tf already covers image pull, logs and the database secret.
#
# Credential rotation: ECS injects DB_PASSWORD once, at task start, and RDS
# rotates it every 7 days. A running process keeps its open connections, but
# its next new connection is refused with SQLSTATE 28P01. Each entrypoint
# then stops and exits non-zero (server/src/db/pool-config.ts), and the
# service starts a replacement task, which resolves the secret again and
# gets the current password. See "Credential rotation for long-running
# tasks" in docs/cloud-architecture.md.

locals {
  task_subnet_ids = [aws_subnet.public_a.id, aws_subnet.public_b.id]
  app_image       = var.image_tag == null ? null : "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
}

# --- ALB -------------------------------------------------------------------------
#
# Plain HTTP on 80: there is no domain or ACM certificate yet, so traffic
# between the client and the ALB is unencrypted. The API serves no
# credentials and accepts no writes (health and read-only event routes, plus
# the static frontend).

resource "aws_lb" "api" {
  count = var.enable_services ? 1 : 0

  name               = "${var.name}-api"
  load_balancer_type = "application"
  internal           = false
  ip_address_type    = "ipv4"
  security_groups    = [aws_security_group.alb.id]
  subnets            = local.task_subnet_ids

  # The SSE stream writes a keepalive comment every 500 ms while idle
  # (server/src/api/events.ts), so the default 60 s idle timeout never
  # closes a healthy stream.
  idle_timeout = 60

  # Rejects requests with header names that aren't valid HTTP tokens instead
  # of forwarding them. Nothing in the API relies on such headers.
  drop_invalid_header_fields = true

  # Created and destroyed with enable_services, like everything here.
  enable_deletion_protection = false

  tags = { Name = "${var.name}-api" }
}

resource "aws_lb_target_group" "api" {
  count = var.enable_services ? 1 : 0

  name = "${var.name}-api"
  # awsvpc tasks are registered by private IP, not by instance.
  target_type = "ip"
  protocol    = "HTTP"
  port        = 3000
  vpc_id      = aws_vpc.main.id

  # When ECS stops an API task (deployment, scale-in), it deregisters it
  # first and sends SIGTERM only after this delay. Ordinary requests finish
  # in milliseconds; open SSE streams would hold the target for the whole
  # delay (300 s by default), because they never end on their own. 30 s
  # bounds that: the task then gets SIGTERM, closes its streams, and each
  # browser reconnects through the ALB to a healthy task with
  # Last-Event-ID, losing no events.
  deregistration_delay = 30

  # Liveness, not readiness. For an ECS service behind a load balancer, a
  # target that fails this check is not only taken out of rotation: ECS
  # stops the task and starts another. /api/health/ready fails whenever
  # PostgreSQL is unreachable, which is a database outage, not a broken API
  # process; replacing API tasks during one would drop every SSE stream and
  # fix nothing. /api/health/live fails only when the process can't answer
  # HTTP, which a replacement does fix. A task whose password was rotated
  # away exits on its own (see the header), so readiness isn't needed to
  # catch that either. /api/health/ready remains for checking API -> RDS by
  # hand through the ALB.
  health_check {
    protocol            = "HTTP"
    port                = "traffic-port"
    path                = "/api/health/live"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = { Name = "${var.name}-api" }
}

resource "aws_lb_listener" "api_http" {
  count = var.enable_services ? 1 : 0

  load_balancer_arn = aws_lb.api[0].arn
  protocol          = "HTTP"
  port              = 80

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api[0].arn
  }

  tags = { Name = "${var.name}-api-http" }
}

# --- Task definitions ------------------------------------------------------------
#
# Same size and platform as the migration task: 0.25 vCPU / 512 MiB on ARM64
# (the image is linux/arm64). Each process opens at most DB_POOL_MAX (default
# 4) PostgreSQL connections.
#
# stopTimeout is how long ECS waits after SIGTERM before SIGKILL. Each
# entrypoint handles SIGTERM itself and exits once it has stopped cleanly.

resource "aws_ecs_task_definition" "api" {
  count = var.enable_services ? 1 : 0

  family                   = "${var.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.ecs_execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([{
    name      = "api"
    image     = local.app_image
    essential = true
    # The image's default CMD, written out so each role's command is visible
    # here.
    command = ["node", "dist/server/src/index.js"]

    # In awsvpc mode the host port is the container port; stated so the
    # definition matches what ECS returns.
    portMappings = [{ containerPort = 3000, hostPort = 3000, protocol = "tcp" }]

    environment = concat(local.db_environment, [{ name = "PORT", value = "3000" }])
    secrets     = local.db_secrets

    # SIGTERM closes open event streams, waits for in-flight requests and
    # closes the pool (server/src/index.ts); that takes well under a second.
    stopTimeout = 30

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.ecs.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "api"
      }
    }
  }])

  tags = { Name = "${var.name}-api" }
}

resource "aws_ecs_task_definition" "worker" {
  count = var.enable_services ? 1 : 0

  family                   = "${var.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.ecs_execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([{
    name      = "worker"
    image     = local.app_image
    essential = true
    # No worker ID argument and no WORKER_ID: each process then names itself
    # worker-<random UUID>. A fixed ID here would give every task in the
    # service the same name.
    command = ["node", "dist/server/src/worker/worker.js"]

    environment = local.db_environment
    secrets     = local.db_secrets

    # On SIGTERM the worker stops claiming but finishes the step it holds,
    # renewing its lease meanwhile (server/src/worker/worker.ts). The demo
    # executor waits at most 60 s, so 120 s (the Fargate maximum) leaves room
    # for that plus completion. If a step outlasts it, SIGKILL ends the
    # process, the lease expires, the coordinator makes the step claimable
    # again and it runs again: at-least-once, as designed.
    stopTimeout = 120

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.ecs.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "worker"
      }
    }
  }])

  tags = { Name = "${var.name}-worker" }
}

resource "aws_ecs_task_definition" "coordinator" {
  count = var.enable_services ? 1 : 0

  family                   = "${var.name}-coordinator"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.ecs_execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([{
    name      = "coordinator"
    image     = local.app_image
    essential = true
    command   = ["node", "dist/server/src/coordinator/coordinator.js"]

    environment = local.db_environment
    secrets     = local.db_secrets

    # SIGTERM lets the current sweep (two short statements) finish, then the
    # process closes its pool and exits.
    stopTimeout = 30

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.ecs.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "coordinator"
      }
    }
  }])

  tags = { Name = "${var.name}-coordinator" }
}

# --- Services --------------------------------------------------------------------
#
# Rolling deployments that start the new task before stopping the old one
# (minimum 100 %, maximum 200 %). Running an old and a new process of the
# same role side by side is safe for every role: two workers compete for
# steps through the same locked claim, and two coordinators duplicate a
# recovery sweep without corrupting it (server/src/coordinator/recovery-loop.ts).
#
# The circuit breaker marks a deployment failed when its tasks keep failing
# to start or stay healthy, and rolls back to the last completed one instead
# of retrying forever. It applies only during deployments; outside them, a
# task that exits (for example after a credential rotation) is simply
# replaced.
#
# propagate_tags copies the service's tags (Project, ManagedBy, Name) onto
# every task it starts, so Fargate usage is attributed to the Project tag
# that the budget filters on.
#
# depends_on the execution role's policies: tasks need them to pull the
# image, write logs and read the secret, and on teardown the services must
# stop their tasks before those permissions are removed.

# Deployment ownership boundary: Terraform owns each service's networking,
# scaling and deployment policy, while CI/CD owns which task-definition
# revision the service runs. Ignoring task_definition prevents a later
# infrastructure plan from rolling a successful CI deployment back to the
# bootstrap revision recorded in Terraform state.

resource "aws_ecs_service" "api" {
  count = var.enable_services ? 1 : 0

  name            = "api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api[0].arn
  desired_count   = var.api_desired_count
  launch_type     = "FARGATE"
  propagate_tags  = "SERVICE"

  lifecycle {
    ignore_changes = [task_definition]
  }

  network_configuration {
    subnets          = local.task_subnet_ids
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api[0].arn
    container_name   = "api"
    container_port   = 3000
  }

  # Time after a task starts during which failed ALB health checks don't
  # count against it: covers the image pull and Node startup.
  health_check_grace_period_seconds = 60

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  tags = { Name = "${var.name}-api" }

  # ECS rejects a service whose target group isn't yet attached to a load
  # balancer; the listener is what attaches it.
  depends_on = [
    aws_lb_listener.api_http,
    aws_iam_role_policy.ecs_execution_base,
    aws_iam_role_policy.ecs_execution_db_secret,
  ]
}

resource "aws_ecs_service" "worker" {
  count = var.enable_services ? 1 : 0

  name            = "worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker[0].arn
  desired_count   = var.worker_desired_count
  launch_type     = "FARGATE"
  propagate_tags  = "SERVICE"

  lifecycle {
    ignore_changes = [task_definition]
  }

  network_configuration {
    subnets          = local.task_subnet_ids
    security_groups  = [aws_security_group.backend.id]
    assign_public_ip = true
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  tags = { Name = "${var.name}-worker" }

  depends_on = [
    aws_iam_role_policy.ecs_execution_base,
    aws_iam_role_policy.ecs_execution_db_secret,
  ]
}

resource "aws_ecs_service" "coordinator" {
  count = var.enable_services ? 1 : 0

  name            = "coordinator"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.coordinator[0].arn
  desired_count   = var.coordinator_desired_count
  launch_type     = "FARGATE"
  propagate_tags  = "SERVICE"

  lifecycle {
    ignore_changes = [task_definition]
  }

  network_configuration {
    subnets          = local.task_subnet_ids
    security_groups  = [aws_security_group.backend.id]
    assign_public_ip = true
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  tags = { Name = "${var.name}-coordinator" }

  depends_on = [
    aws_iam_role_policy.ecs_execution_base,
    aws_iam_role_policy.ecs_execution_db_secret,
  ]
}
