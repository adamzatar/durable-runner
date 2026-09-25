# required_version bounds the Terraform CLI that may run this configuration.
# Terraform 1.x promises backward compatibility within the major version, so
# the ceiling is the next major; the floor is a recent release rather than
# the version that happened to be installed when this was written.
#
# The provider constraint "~> 6.0" allows any 6.x release but never 7.0,
# because a provider major version is where AWS resource schemas change
# incompatibly. The exact provider build chosen by `terraform init` is
# recorded in .terraform.lock.hcl (tracked in git), so every run uses the
# same provider until someone deliberately runs `terraform init -upgrade`.
#
# No backend block: state is local (infra/terraform.tfstate, gitignored).
# See docs/cloud-architecture.md for why, and what that trades away.
terraform {
  required_version = ">= 1.10, < 2.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}
