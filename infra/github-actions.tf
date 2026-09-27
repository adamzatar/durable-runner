# GitHub Actions deployment identity.
#
# The account-wide GitHub OIDC provider already exists outside this
# configuration. We read it as data rather than importing or managing it.
#
# The trust relationship is deliberately restricted to this repository's
# immutable GitHub owner/repository IDs and the main branch. No long-lived
# AWS access key is stored in GitHub.

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

data "aws_iam_openid_connect_provider" "github_actions" {
  arn = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com"
}

locals {
  github_actions_subject = "repo:adamzatar@190796061/durable-runner@1373792180:ref:refs/heads/main"

  github_actions_task_definition_arns = [
    "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${var.name}-api:*",
    "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${var.name}-worker:*",
    "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${var.name}-coordinator:*",
    "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${var.name}-migrate:*",
  ]

  github_actions_service_arns = [
    "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service/${var.name}/api",
    "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service/${var.name}/worker",
    "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service/${var.name}/coordinator",
  ]
}

resource "aws_iam_role" "github_actions_deploy" {
  name                 = "${var.name}-github-deploy"
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = data.aws_iam_openid_connect_provider.github_actions.arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = local.github_actions_subject
        }
      }
    }]
  })

  tags = {
    Name = "${var.name}-github-deploy"
  }
}

resource "aws_iam_role_policy" "github_actions_deploy" {
  name = "deploy-durable-runner"
  role = aws_iam_role.github_actions_deploy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # ECR login tokens cannot be scoped to a repository.
        Sid      = "EcrLogin"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        # Docker may push only to this project's repository.
        Sid    = "PushImage"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:CompleteLayerUpload",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
          "ecr:DescribeImages",
        ]
        Resource = aws_ecr_repository.app.arn
      },
      {
        # A deployment registers new revisions only in this project's four
        # task-definition families.
        Sid      = "RegisterTaskDefinitions"
        Effect   = "Allow"
        Action   = "ecs:RegisterTaskDefinition"
        Resource = local.github_actions_task_definition_arns
      },
      {
        # Deploy new revisions only to the three Durable Runner services.
        Sid      = "UpdateServices"
        Effect   = "Allow"
        Action   = "ecs:UpdateService"
        Resource = local.github_actions_service_arns
      },
      {
        # A migration is a one-off task and may run only from the migration
        # task-definition family on this project's ECS cluster.
        Sid      = "RunMigration"
        Effect   = "Allow"
        Action   = "ecs:RunTask"
        Resource = "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${var.name}-migrate:*"
        Condition = {
          ArnEquals = {
            "ecs:cluster" = aws_ecs_cluster.main.arn
          }
        }
      },
      {
        # Read-only deployment/status operations. Several ECS describe/list
        # APIs either do not support useful resource scoping or return
        # dynamically created task ARNs.
        Sid    = "ReadDeploymentState"
        Effect = "Allow"
        Action = [
          "ecs:DescribeServices",
          "ecs:DescribeTasks",
          "ecs:DescribeTaskDefinition",
          "ecs:ListTasks",
          "elasticloadbalancing:DescribeLoadBalancers",
          "elasticloadbalancing:DescribeTargetHealth",
        ]
        Resource = "*"
      },
      {
        # ECS must be allowed to use the existing execution role referenced
        # by newly registered task-definition revisions. No other role may
        # be passed.
        Sid      = "PassEcsExecutionRole"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = aws_iam_role.ecs_execution.arn
        Condition = {
          StringEquals = {
            "iam:PassedToService" = "ecs-tasks.amazonaws.com"
          }
        }
      },
    ]
  })
}

output "github_actions_deploy_role_arn" {
  value = aws_iam_role.github_actions_deploy.arn
}
