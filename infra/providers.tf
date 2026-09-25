provider "aws" {
  region = var.aws_region

  # Applied to every taggable resource, so anything this configuration
  # creates can be found (and costed) by tag in the console. Individual
  # resources add their own Name tag.
  default_tags {
    tags = {
      Project   = var.name
      ManagedBy = "terraform"
    }
  }
}
