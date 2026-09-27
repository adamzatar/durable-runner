variable "aws_region" {
  description = "Region for every resource in this configuration."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  description = "Prefix for resource names. There is one environment; this is not a multi-environment switch."
  type        = string
  default     = "durable-runner-dev"
}

variable "enable_budget" {
  description = "Create the Project-tag-filtered cost budget. Leave false until the Project tag is activated as a cost allocation tag in Billing (see budget.tf)."
  type        = bool
  default     = false
}

variable "budget_alert_email" {
  description = "Address that receives AWS Budgets alerts. Required when enable_budget is true. Supplied via terraform.tfvars (gitignored) or TF_VAR_budget_alert_email; never committed."
  type        = string
  sensitive   = true
  default     = null

  validation {
    condition     = var.budget_alert_email == null ? !var.enable_budget : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.budget_alert_email))
    error_message = "budget_alert_email must be an email address, and is required when enable_budget is true."
  }
}

variable "enable_database" {
  description = "Whether the billable RDS instance exists. Setting it false destroys the instance and its data (no final snapshot); the DB subnet group stays."
  type        = bool
  default     = false
}

variable "db_instance_class" {
  description = "RDS instance class. db.t4g.micro (2 burstable Graviton vCPUs, 1 GiB) is the smallest Graviton class orderable for PostgreSQL 16 in us-east-1."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "RDS gp3 storage in GiB. 20 is the gp3 minimum; storage autoscaling is off, so this is also the maximum."
  type        = number
  default     = 20
}

variable "image_tag" {
  description = "Full 40-character Git commit SHA the ECR image was pushed under; task definitions run that exact image. null (the default) creates no task definition. Supplied per plan (-var or TF_VAR_image_tag), not stored in tfvars."
  type        = string
  default     = null

  validation {
    condition     = var.image_tag == null || can(regex("^[0-9a-f]{40}$", var.image_tag))
    error_message = "image_tag must be a full 40-character lowercase Git commit SHA."
  }
}

variable "enable_services" {
  description = "Whether the ALB and the API, worker and coordinator ECS services exist. The ALB bills by the hour whether or not any task runs; setting this false removes it along with the services. Requires enable_database and image_tag."
  type        = bool
  default     = false

  validation {
    condition     = !var.enable_services || (var.enable_database && var.image_tag != null)
    error_message = "enable_services requires enable_database = true and image_tag set."
  }
}

# Separate counts so each role can be scaled on its own, including to zero,
# without touching the others or the ALB. The upper bounds are typo guards
# for a cost-limited account, not capacity limits of the design.

variable "api_desired_count" {
  description = "Running API tasks. 0 keeps the ALB but serves nothing (the ALB answers 503)."
  type        = number
  default     = 1

  validation {
    condition     = var.api_desired_count >= 0 && var.api_desired_count <= 2 && floor(var.api_desired_count) == var.api_desired_count
    error_message = "api_desired_count must be a whole number from 0 to 2."
  }
}

variable "worker_desired_count" {
  description = "Running worker tasks. Each runs one worker loop, which executes one step at a time."
  type        = number
  default     = 1

  validation {
    condition     = var.worker_desired_count >= 0 && var.worker_desired_count <= 8 && floor(var.worker_desired_count) == var.worker_desired_count
    error_message = "worker_desired_count must be a whole number from 0 to 8."
  }
}

variable "coordinator_desired_count" {
  description = "Running coordinator tasks: 1, or 0 to stop lease recovery and retry promotion."
  type        = number
  default     = 1

  validation {
    condition     = var.coordinator_desired_count == 0 || var.coordinator_desired_count == 1
    error_message = "coordinator_desired_count must be 0 or 1."
  }
}
