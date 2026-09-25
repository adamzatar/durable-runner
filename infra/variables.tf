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
