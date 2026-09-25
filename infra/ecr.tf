# One private repository for the one image. API, worker, coordinator and
# migration tasks all run the same image with different commands, so they
# share a repository and, per deployment, the same tag.
resource "aws_ecr_repository" "app" {
  name = "durable-runner"

  # Deployments will tag images with the Git commit SHA. Immutable tags mean
  # a SHA always refers to the exact bytes first pushed under it: a task
  # definition that names a tag can't silently start running a different
  # image, and a rollback to an older SHA gets the old image. The cost is
  # that no moving tag like "latest" can be re-pushed.
  image_tag_mutability = "IMMUTABLE"

  # Basic scanning on push (no extra charge; Enhanced/Inspector scanning is a
  # separate paid, account-level setting and is not enabled here). Findings
  # are informational; nothing here blocks a push or a deploy on them.
  image_scanning_configuration {
    scan_on_push = true
  }

  # AES256 = Amazon S3-managed keys. No customer-managed KMS key, which
  # would add a monthly key charge and key policy to maintain.
  encryption_configuration {
    encryption_type = "AES256"
  }

  # force_delete is left at its default (false): `terraform destroy` fails
  # while images remain, rather than deleting them. Tearing down means
  # deleting images first, deliberately.

  tags = { Name = "durable-runner" }
}

# Only untagged images are ever expired. With immutable tags, images become
# untagged mainly from interrupted/partial pushes or build-tool artifacts;
# every SHA-tagged image, including whatever is deployed, is kept. Tagged
# retention can be added later if storage actually grows.
resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 14 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 14
        }
        action = { type = "expire" }
      }
    ]
  })
}
