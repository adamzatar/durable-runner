# ECS foundation plus the one-off migration task definition. Nothing in this
# file runs until a task is started explicitly with `aws ecs run-task`, and a
# cluster with no running tasks costs nothing. The long-running services and
# the ALB are in services.tf.

resource "aws_ecs_cluster" "main" {
  name = var.name

  # Container Insights is a paid CloudWatch feature; not needed yet.
  setting {
    name  = "containerInsights"
    value = "disabled"
  }

  tags = { Name = var.name }
}

# One log group for every role. Each task definition writes under its own
# stream prefix (migrate/ here), so roles stay separable without a group
# each. Retention is bounded so logs, and their storage cost, don't
# accumulate between experiments. Destroying the group deletes its logs.
resource "aws_cloudwatch_log_group" "ecs" {
  name              = "/ecs/${var.name}"
  retention_in_days = 7
  tags              = { Name = var.name }
}

# --- Task execution role -------------------------------------------------------
#
# Used by the ECS/Fargate agent, not by application code: it pulls the image,
# creates the log stream and ships stdout/stderr, and reads the database
# password from Secrets Manager to inject it as DB_PASSWORD at task start.
# The containers never receive these credentials.
#
# The trust policy is the one AWS documents for execution roles, without the
# aws:SourceAccount / aws:SourceArn conditions it documents for *task* roles:
# the execution-role documentation doesn't list them, and a condition ECS
# doesn't populate would stop every task from starting. Another account
# can't attach this role to its own task definitions: that requires
# iam:PassRole on it, which only principals in this account can hold.
resource "aws_iam_role" "ecs_execution" {
  name = "${var.name}-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = { Name = "${var.name}-ecs-execution" }
}

# Inline and scoped to this project's resources, instead of the AWS managed
# AmazonECSTaskExecutionRolePolicy, which allows pulling from every
# repository and writing to every log group in the account.
resource "aws_iam_role_policy" "ecs_execution_base" {
  name = "image-pull-and-logs"
  role = aws_iam_role.ecs_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Registry-level login token; this action has no resource to scope to.
        Sid      = "EcrAuthToken"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Sid      = "PullAppImage"
        Effect   = "Allow"
        Action   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
        Resource = aws_ecr_repository.app.arn
      },
      {
        # Both the group ARN and its streams, so that CreateLogStream and
        # PutLogEvents are allowed however each is evaluated, and only here.
        Sid      = "WriteTaskLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = [aws_cloudwatch_log_group.ecs.arn, "${aws_cloudwatch_log_group.ecs.arn}:log-stream:*"]
      },
    ]
  })
}

# Read access to exactly one secret: the master-user secret RDS created for
# this instance. The ARN is stable across RDS's 7-day rotations; it changes
# only if the instance is recreated, which updates this policy with it. No
# kms:Decrypt: the secret is encrypted with the AWS managed
# aws/secretsmanager key, which needs no key permission from the caller.
resource "aws_iam_role_policy" "ecs_execution_db_secret" {
  count = var.enable_database ? 1 : 0

  name = "read-rds-master-secret"
  role = aws_iam_role.ecs_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "ReadRdsMasterSecret"
      Effect   = "Allow"
      Action   = "secretsmanager:GetSecretValue"
      Resource = aws_db_instance.main[0].master_user_secret[0].secret_arn
    }]
  })
}

# --- Database settings shared by every task definition -------------------------
#
# Cloud DB_* configuration (server/src/db/connection-config.ts), used by the
# migration task here and the services in services.tf. Empty while the
# instance is off; nothing that uses them exists then.
#
# Individual attributes only, never the whole instance object: it contains
# sensitive attributes, and anything computed from it (even `== null`) is
# marked sensitive, which would hide these task definitions from plan
# review.
locals {
  # Not secret, so plain values, visible in the task definition. Listed
  # alphabetically, the order ECS returns them in, so Terraform doesn't
  # report a spurious diff.
  db_environment = var.enable_database ? [
    { name = "DB_HOST", value = aws_db_instance.main[0].address },
    { name = "DB_NAME", value = aws_db_instance.main[0].db_name },
    { name = "DB_PORT", value = tostring(aws_db_instance.main[0].port) },
    # Where the Dockerfile packages the RDS CA bundle.
    { name = "DB_SSL_CA_FILE", value = "/app/certs/rds-global-bundle.pem" },
    { name = "DB_USER", value = aws_db_instance.main[0].username },
  ] : []

  # The password only, extracted from the secret's JSON by key. ECS resolves
  # it once, at task start, using the execution role; it never appears in
  # the task definition, Terraform state or plan. The secret ARN stays the
  # same across rotations, so a task started after a rotation gets the new
  # password with no change here.
  db_secrets = var.enable_database ? [
    { name = "DB_PASSWORD", valueFrom = "${aws_db_instance.main[0].master_user_secret[0].secret_arn}:password::" },
  ] : []
}

# --- Migration task definition ---------------------------------------------------
#
# Runs `node dist/server/src/db/migrate.js` from the SHA-tagged image, then
# exits. It needs both the database (for its address and secret) and an
# image tag, so it exists only when both are present.
#
# No task role (task_role_arn unset): the application makes no AWS API calls,
# so the containers get no AWS credentials at all.
#
# ARM64: Fargate on Graviton is cheaper per vCPU-hour, and images built on
# this repo's Apple Silicon development machine are linux/arm64 by default.
# An image built for amd64 would fail to start under this setting.
#
# Networking is chosen at run time, not here: launch with the public subnets,
# the backend security group and assignPublicIp=ENABLED (see
# docs/cloud-architecture.md for why public subnets and no NAT).
resource "aws_ecs_task_definition" "migrate" {
  count = var.enable_database && var.image_tag != null ? 1 : 0

  family                   = "${var.name}-migrate"
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
    name      = "migrate"
    image     = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
    essential = true
    command   = ["node", "dist/server/src/db/migrate.js"]

    # A task started before a rotation keeps the old password, which is fine
    # for a migration that runs for seconds.
    environment = local.db_environment
    secrets     = local.db_secrets

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.ecs.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "migrate"
      }
    }
  }])

  tags = { Name = "${var.name}-migrate" }
}
