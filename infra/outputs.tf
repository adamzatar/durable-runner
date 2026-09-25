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
