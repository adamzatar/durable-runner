#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${ECS_CLUSTER:?ECS_CLUSTER is required}"
: "${ECR_REPOSITORY:?ECR_REPOSITORY is required}"
: "${IMAGE_URI:?IMAGE_URI is required}"
: "${IMAGE_TAG:?IMAGE_TAG is required}"

export AWS_DEFAULT_REGION="$AWS_REGION"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

register_from_ref() {
  local source_ref="$1"
  local family="$2"
  local source_json="$tmpdir/${family}-source.json"
  local register_json="$tmpdir/${family}-register.json"

  echo "Preparing ${family} from ${source_ref}" >&2

  aws ecs describe-task-definition \
    --task-definition "$source_ref" \
    --query taskDefinition \
    --output json \
    --no-cli-pager > "$source_json"

  if [[ "$(jq '.containerDefinitions | length' "$source_json")" != "1" ]]; then
    echo "Expected exactly one container in ${family}" >&2
    exit 1
  fi

  if [[ -n "$(jq -r '.taskRoleArn // empty' "$source_json")" ]]; then
    echo "Unexpected task role in ${family}; refusing to drop it" >&2
    exit 1
  fi

  jq \
    --arg image "$IMAGE_URI" \
    --arg family "$family" \
    '{
      family: $family,
      executionRoleArn: .executionRoleArn,
      networkMode: .networkMode,
      containerDefinitions: (.containerDefinitions | map(.image = $image)),
      requiresCompatibilities: .requiresCompatibilities,
      cpu: .cpu,
      memory: .memory,
      runtimePlatform: .runtimePlatform,
      volumes: .volumes,
      placementConstraints: .placementConstraints
    }
    | with_entries(select(.value != null))' \
    "$source_json" > "$register_json"

  aws ecs register-task-definition \
    --cli-input-json "file://${register_json}" \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text \
    --no-cli-pager
}

echo "Registering migration task definition"

migration_td="$(
  register_from_ref \
    "${ECS_CLUSTER}-migrate" \
    "${ECS_CLUSTER}-migrate"
)"

echo "Migration revision: ${migration_td}"

worker_network="$(
  aws ecs describe-services \
    --cluster "$ECS_CLUSTER" \
    --services worker \
    --query 'services[0].networkConfiguration' \
    --output json \
    --no-cli-pager
)"

echo "Running database migrations"

migration_run="$(
  aws ecs run-task \
    --cluster "$ECS_CLUSTER" \
    --launch-type FARGATE \
    --task-definition "$migration_td" \
    --network-configuration "$worker_network" \
    --started-by "github-actions-${GITHUB_RUN_ID:-manual}" \
    --output json \
    --no-cli-pager
)"

if [[ "$(jq '.failures | length' <<<"$migration_run")" != "0" ]]; then
  echo "$migration_run" | jq '.failures' >&2
  exit 1
fi

migration_task="$(jq -r '.tasks[0].taskArn // empty' <<<"$migration_run")"

if [[ -z "$migration_task" ]]; then
  echo "ECS returned no migration task ARN" >&2
  exit 1
fi

echo "Migration task: ${migration_task}"

aws ecs wait tasks-stopped \
  --cluster "$ECS_CLUSTER" \
  --tasks "$migration_task"

migration_result="$(
  aws ecs describe-tasks \
    --cluster "$ECS_CLUSTER" \
    --tasks "$migration_task" \
    --output json \
    --no-cli-pager
)"

migration_exit="$(
  jq -r '.tasks[0].containers[0].exitCode // -1' <<<"$migration_result"
)"

if [[ "$migration_exit" != "0" ]]; then
  echo "Migration failed:" >&2
  echo "$migration_result" | jq \
    '.tasks[0] | {
      stopCode,
      stoppedReason,
      containers: [.containers[] | {
        name,
        exitCode,
        reason
      }]
    }' >&2
  exit 1
fi

echo "Migration completed successfully"

api_td="$(register_from_ref "${ECS_CLUSTER}-api" "${ECS_CLUSTER}-api")"
worker_td="$(register_from_ref "${ECS_CLUSTER}-worker" "${ECS_CLUSTER}-worker")"
coordinator_td="$(register_from_ref "${ECS_CLUSTER}-coordinator" "${ECS_CLUSTER}-coordinator")"

echo "New task definitions:"
echo "  api:         $api_td"
echo "  worker:      $worker_td"
echo "  coordinator: $coordinator_td"

aws ecs update-service \
  --cluster "$ECS_CLUSTER" \
  --service api \
  --task-definition "$api_td" \
  --no-cli-pager >/dev/null

aws ecs update-service \
  --cluster "$ECS_CLUSTER" \
  --service worker \
  --task-definition "$worker_td" \
  --no-cli-pager >/dev/null

aws ecs update-service \
  --cluster "$ECS_CLUSTER" \
  --service coordinator \
  --task-definition "$coordinator_td" \
  --no-cli-pager >/dev/null

echo "Waiting for ECS services to become stable"

aws ecs wait services-stable \
  --cluster "$ECS_CLUSTER" \
  --services api worker coordinator

expected_digest="$(
  aws ecr describe-images \
    --repository-name "$ECR_REPOSITORY" \
    --image-ids "imageTag=${IMAGE_TAG}" \
    --query 'imageDetails[0].imageDigest' \
    --output text \
    --no-cli-pager
)"

verify_service() {
  local service="$1"
  local expected_td="$2"

  local actual_td
  actual_td="$(
    aws ecs describe-services \
      --cluster "$ECS_CLUSTER" \
      --services "$service" \
      --query 'services[0].taskDefinition' \
      --output text \
      --no-cli-pager
  )"

  if [[ "$actual_td" != "$expected_td" ]]; then
    echo "${service} is running ${actual_td}, expected ${expected_td}" >&2
    exit 1
  fi

  local -a task_arns=()
  mapfile -t task_arns < <(
    aws ecs list-tasks \
      --cluster "$ECS_CLUSTER" \
      --service-name "$service" \
      --desired-status RUNNING \
      --query 'taskArns[]' \
      --output text \
      --no-cli-pager |
      tr '\t' '\n' |
      sed '/^$/d'
  )

  if [[ "${#task_arns[@]}" -eq 0 ]]; then
    echo "No running tasks found for ${service}" >&2
    exit 1
  fi

  local task_json
  task_json="$(
    aws ecs describe-tasks \
      --cluster "$ECS_CLUSTER" \
      --tasks "${task_arns[@]}" \
      --output json \
      --no-cli-pager
  )"

  local bad
  bad="$(
    jq \
      --arg td "$expected_td" \
      --arg image "$IMAGE_URI" \
      --arg digest "$expected_digest" \
      '[
        .tasks[]
        | select(
            .taskDefinitionArn != $td
            or (.containers | length) != 1
            or .containers[0].image != $image
            or .containers[0].imageDigest != $digest
          )
       ] | length' \
      <<<"$task_json"
  )"

  if [[ "$bad" != "0" ]]; then
    echo "Runtime provenance check failed for ${service}" >&2
    echo "$task_json" | jq '.tasks[] | {
      taskDefinitionArn,
      lastStatus,
      containers: [.containers[] | {
        name,
        image,
        imageDigest,
        lastStatus
      }]
    }' >&2
    exit 1
  fi

  echo "${service}: verified ${expected_digest}"
}

verify_service api "$api_td"
verify_service worker "$worker_td"
verify_service coordinator "$coordinator_td"

alb_dns="$(
  aws elbv2 describe-load-balancers \
    --names "${ECS_CLUSTER}-api" \
    --query 'LoadBalancers[0].DNSName' \
    --output text \
    --no-cli-pager
)"

api_url="http://${alb_dns}"

echo "Smoke testing ${api_url}"

curl \
  --fail \
  --silent \
  --show-error \
  --retry 12 \
  --retry-delay 5 \
  --retry-all-errors \
  "${api_url}/api/health/live"

echo

curl \
  --fail \
  --silent \
  --show-error \
  --retry 12 \
  --retry-delay 5 \
  --retry-all-errors \
  "${api_url}/api/health/ready"

echo

curl \
  --fail \
  --silent \
  --show-error \
  "${api_url}/api/events"

echo
echo "Deployment verified"
