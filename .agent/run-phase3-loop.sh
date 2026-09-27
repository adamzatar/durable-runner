#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

MAX_ITERATIONS="${MAX_ITERATIONS:-8}"
MAX_TURNS="${MAX_TURNS:-35}"

rm -f .agent/HUMAN_GATE.md .agent/BLOCKED.md

echo "Durable Runner Phase 3 autonomous loop"
echo "Max fresh-context iterations: $MAX_ITERATIONS"
echo "Max agentic turns per iteration: $MAX_TURNS"
echo

for ((i=1; i<=MAX_ITERATIONS; i++)); do
  if [[ -f .agent/HUMAN_GATE.md ]]; then
    echo
    echo "=== HUMAN APPROVAL GATE REACHED ==="
    cat .agent/HUMAN_GATE.md
    exit 0
  fi

  if [[ -f .agent/BLOCKED.md ]]; then
    echo
    echo "=== AGENT BLOCKED ==="
    cat .agent/BLOCKED.md
    exit 0
  fi

  timestamp="$(date +%Y%m%d-%H%M%S)"
  logfile=".agent/logs/phase3-${i}-${timestamp}.log"

  echo
  echo "=== ITERATION $i / $MAX_ITERATIONS ==="
  echo "Log: $logfile"

  claude -p "$(cat .agent/PHASE3_PROMPT.md)" \
    --model opus \
    --max-turns "$MAX_TURNS" \
    --permission-mode acceptEdits \
    --allowedTools \
      "Read" \
      "Edit" \
      "Write" \
      "Glob" \
      "Grep" \
      "WebSearch" \
      "WebFetch" \
      "Bash(git status:*)" \
      "Bash(git diff:*)" \
      "Bash(git log:*)" \
      "Bash(git show:*)" \
      "Bash(git rev-parse:*)" \
      "Bash(npm test:*)" \
      "Bash(npm run:*)" \
      "Bash(npx:*)" \
      "Bash(node:*)" \
      "Bash(docker build:*)" \
      "Bash(docker inspect:*)" \
      "Bash(docker run:*)" \
      "Bash(terraform fmt:*)" \
      "Bash(terraform validate:*)" \
      "Bash(terraform plan:*)" \
      "Bash(terraform show:*)" \
    --disallowedTools \
      "Bash(terraform apply:*)" \
      "Bash(terraform destroy:*)" \
      "Bash(git push:*)" \
      "Bash(git reset:*)" \
      "Bash(git clean:*)" \
      "Bash(aws ecr put-*:*)" \
      "Bash(aws ecr batch-delete-*:*)" \
      "Bash(aws ecs create-*:*)" \
      "Bash(aws ecs update-*:*)" \
      "Bash(aws ecs delete-*:*)" \
      "Bash(aws ecs run-task:*)" \
      "Bash(aws ec2 authorize-*:*)" \
      "Bash(aws ec2 revoke-*:*)" \
      "Bash(aws iam create-*:*)" \
      "Bash(aws iam put-*:*)" \
      "Bash(aws iam attach-*:*)" \
      "Bash(aws iam delete-*:*)" \
      "Bash(aws secretsmanager get-secret-value:*)" \
    --output-format text \
    2>&1 | tee "$logfile"

done

echo
echo "=== MAX ITERATIONS REACHED ==="
echo "No AWS mutation was authorized."
echo "Review .agent/STATE.md, .agent/PLAN.md and the logs before continuing."
exit 0
