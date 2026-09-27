output "aws_region" {
  value = var.aws_region
}

output "availability_zones" {
  value = local.azs
}

output "vpc_id" {
  value = aws_vpc.main.id
}

output "public_subnet_ids" {
  value = [aws_subnet.public_a.id, aws_subnet.public_b.id]
}

output "private_db_subnet_ids" {
  value = [aws_subnet.private_db_a.id, aws_subnet.private_db_b.id]
}

output "security_group_ids" {
  value = {
    alb     = aws_security_group.alb.id
    api     = aws_security_group.api.id
    backend = aws_security_group.backend.id
    rds     = aws_security_group.rds.id
  }
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

# Non-secret pieces of the future DATABASE_URL. The password is never an
# output: it lives only in the RDS-managed secret below. The instance is
# conditional (enable_database), so each value is null while it's off;
# one() returns the single element or null for an empty list.
output "db_address" {
  value = one(aws_db_instance.main[*].address)
}

output "db_port" {
  value = one(aws_db_instance.main[*].port)
}

output "db_name" {
  value = one(aws_db_instance.main[*].db_name)
}

output "db_username" {
  value = one(aws_db_instance.main[*].username)
}

output "db_engine_version_actual" {
  value = one(aws_db_instance.main[*].engine_version_actual)
}

# The secret's ARN identifies it but grants nothing: reading the value
# still requires secretsmanager:GetSecretValue. So it's a normal output, not
# a sensitive one. try() covers both the instance and its nested
# master_user_secret block being absent.
output "db_master_user_secret_arn" {
  value = try(aws_db_instance.main[0].master_user_secret[0].secret_arn, null)
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "ecs_log_group_name" {
  value = aws_cloudwatch_log_group.ecs.name
}

# null until both enable_database and image_tag are set.
output "migration_task_definition_arn" {
  value = one(aws_ecs_task_definition.migrate[*].arn)
}

# The rest are null while enable_services is false.

output "api_url" {
  value = try("http://${aws_lb.api[0].dns_name}", null)
}

output "alb_arn" {
  value = one(aws_lb.api[*].arn)
}

output "api_target_group_arn" {
  value = one(aws_lb_target_group.api[*].arn)
}

output "ecs_service_names" {
  value = var.enable_services ? {
    api         = aws_ecs_service.api[0].name
    worker      = aws_ecs_service.worker[0].name
    coordinator = aws_ecs_service.coordinator[0].name
  } : null
}

output "service_task_definition_arns" {
  value = var.enable_services ? {
    api         = aws_ecs_task_definition.api[0].arn
    worker      = aws_ecs_task_definition.worker[0].arn
    coordinator = aws_ecs_task_definition.coordinator[0].arn
  } : null
}
