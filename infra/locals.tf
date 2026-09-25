# Standard AZs only (no Local Zones / Wavelength), sorted by name, first two.
#
# Deliberately not filtered by state = "available": during an AZ impairment
# AWS can report a zone as not available, which would shift this list and
# make Terraform plan to destroy and recreate subnets in a different zone.
# Filtering only on opt-in status keeps the selection stable.
#
# AZ *names* (us-east-1a) map to different physical zones in each account;
# the plan output shows which names were chosen for this account.
data "aws_availability_zones" "standard" {
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  azs = slice(sort(data.aws_availability_zones.standard.names), 0, 2)
}
