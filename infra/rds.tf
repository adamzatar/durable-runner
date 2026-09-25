# One small, private, encrypted PostgreSQL 16 instance for a development
# deployment that is created for a test, measured, and destroyed. Several
# settings below (single-AZ, 1-day backups, no deletion protection, no final
# snapshot) are deliberate for that lifecycle and are NOT appropriate
# defaults for a production database holding data that matters.

# Placement: exactly the two private DB subnets, whose route table has no
# internet route. RDS requires a subnet group spanning at least two AZs even
# for a single-AZ instance; the instance itself runs in one of them.
resource "aws_db_subnet_group" "main" {
  name        = var.name
  description = "Durable Runner private DB subnets"
  subnet_ids  = [aws_subnet.private_db_a.id, aws_subnet.private_db_b.id]
  tags        = { Name = var.name }
}

# Only the instance is conditional: it is the billable part and holds the
# data. The subnet group above is free, holds nothing, and stays as part of
# the network foundation. Turning enable_database from true to false
# destroys the instance and ALL its data: skip_final_snapshot is on and
# automated backups are deleted with it. This is the normal teardown path
# between experiments; `terraform destroy -target=...` is for emergencies,
# not routine use.
resource "aws_db_instance" "main" {
  count = var.enable_database ? 1 : 0

  identifier = var.name

  engine = "postgres"
  # Major version only. RDS picks its current default 16.x minor at creation
  # and auto_minor_version_upgrade applies later minors in the maintenance
  # window; the provider treats "16" as matching any 16.x, so those upgrades
  # don't show up as Terraform drift. The exact running version is exposed
  # as engine_version_actual. Pinning a minor (e.g. "16.15") would instead
  # make every AWS-applied upgrade a diff Terraform wants to revert.
  engine_version             = "16"
  auto_minor_version_upgrade = true
  instance_class             = var.db_instance_class

  # gp3 below 400 GiB has a fixed baseline (3000 IOPS, 125 MiB/s); neither
  # can be raised at this size, so they're not set. No max_allocated_storage:
  # storage autoscaling stays off, so storage (and its cost) can't grow on
  # its own.
  storage_type      = "gp3"
  allocated_storage = var.db_allocated_storage
  # Encrypted with the AWS-managed aws/rds key; no customer-managed KMS key.
  storage_encrypted = true

  db_name  = "durable_runner"
  username = "durable_runner_admin"
  # RDS generates the master password and stores it in a Secrets Manager
  # secret it owns (and deletes with the instance). No password is ever in
  # this configuration, in tfvars, or in Terraform state; state holds only
  # the secret's ARN. RDS rotates it every 7 days by default.
  manage_master_user_password = true

  # Network boundary: private subnets, the rds security group only (which
  # admits 5432 from the api and backend groups), and no public IP. The
  # instance still gets a DNS name, but it resolves to a private 10.0.x.x
  # address reachable only from inside the VPC.
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  multi_az               = false
  port                   = 5432

  # Default parameter group (default.postgres16). It sets rds.force_ssl = 1,
  # so every client connection must use TLS.

  # One day of automated backups keeps point-in-time restore available for
  # the length of an experiment; backup storage up to the provisioned size
  # carries no extra charge. RDS picks the backup and maintenance windows.
  backup_retention_period  = 1
  copy_tags_to_snapshot    = true
  delete_automated_backups = true

  # Teardown is intentional: `terraform destroy` deletes the instance with no
  # final snapshot. Production would set deletion_protection = true and keep
  # a final snapshot.
  deletion_protection = false
  skip_final_snapshot = true

  # No paid monitoring extras: no Enhanced Monitoring, no Performance
  # Insights retention.
  monitoring_interval          = 0
  performance_insights_enabled = false

  tags = { Name = var.name }
}
