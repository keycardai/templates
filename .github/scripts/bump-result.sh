#!/usr/bin/env bash
set -euo pipefail

MARKER="<!-- dependency-bump -->"
MAX_ATTEMPTS=3

attempt="${ATTEMPT:-1}"
if [[ ! "$attempt" =~ ^[1-9][0-9]*$ ]]; then
  attempt=1
fi

set_status() {
  local state="$1"
  local description="${2:0:140}"
  gh api -X POST "repos/${GITHUB_REPOSITORY}/statuses/${HEAD_SHA}" \
    -f state="$state" \
    -f context="dependency-bump/verify-eval" \
    -f description="$description" \
    -f target_url="$RUN_URL" > /dev/null
}

find_comment_id() {
  gh api --paginate "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments?per_page=100" \
    --jq '.[] | select(.body | contains("<!-- dependency-bump -->")) | .id' \
    | tail -n 1 || true
}

upsert_comment() {
  local body="$1"
  local comment_id
  comment_id=$(find_comment_id)
  if [ -n "$comment_id" ]; then
    gh api -X PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/${comment_id}" \
      -f body="$body" > /dev/null
  else
    gh api -X POST "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments" \
      -f body="$body" > /dev/null
  fi
}

update_existing_comment() {
  local body="$1"
  local comment_id
  comment_id=$(find_comment_id)
  if [ -n "$comment_id" ]; then
    gh api -X PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/${comment_id}" \
      -f body="$body" > /dev/null
  fi
}

pr_json=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}")
pr_state=$(jq -r '.state // ""' <<< "$pr_json")
current_sha=$(jq -r '.head.sha // ""' <<< "$pr_json")
is_security=$(jq -r '
  (
    ((.head.ref // "") | test("^dependabot/[^/]+/[^/]+/security(-|$)")) or
    (([.labels[]?.name] | any(test("^security$"; "i"))))
  ) | tostring
' <<< "$pr_json")

security_note=""
if [ "$is_security" = "true" ]; then
  security_note=$'\n\nNote: Security update PRs use the same verify and eval gate and are never held by cooldown.'
fi

if [ "$GATE_OK" = "true" ] && [ "$VERIFY_RESULT" = "success" ] && [ "$EVAL_RESULT" = "success" ]; then
  set_status "success" "Verify and eval passed"

  if [ "$pr_state" != "open" ]; then
    echo "PR #${PR_NUMBER} is no longer open (state: ${pr_state}); skipping merge."
    exit 0
  fi

  if [ "$current_sha" != "$HEAD_SHA" ]; then
    echo "PR #${PR_NUMBER} head SHA changed (${current_sha} != ${HEAD_SHA}); skipping merge."
    exit 0
  fi

  if ! gh pr merge "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --squash --match-head-commit "$HEAD_SHA"; then
    set_status "failure" "Verify and eval passed, but squash merge failed"
    body="${MARKER}"$'\n'"Dependency bump verify and eval passed for \`${HEAD_SHA}\`, but squash merge failed. See the [Dependency Bump run](${RUN_URL}).${security_note}"
    upsert_comment "$body"
    exit 1
  fi

  ci_dispatch_note=""
  if gh workflow run ci.yml --repo "$GITHUB_REPOSITORY" --ref main; then
    ci_dispatch_note=" Dispatched [Template CI on main](${CI_WORKFLOW_URL})."
  else
    echo "::warning::Merged PR #${PR_NUMBER}, but failed to dispatch Template CI on main."
    ci_dispatch_note=" Failed to dispatch [Template CI on main](${CI_WORKFLOW_URL}); check workflow runs."
  fi

  body="${MARKER}"$'\n'"Dependency bump verify and eval passed for \`${HEAD_SHA}\` and this PR was squash merged.${ci_dispatch_note} See the [Dependency Bump run](${RUN_URL}).${security_note}"
  update_existing_comment "$body"
  exit 0
fi

if [ "$GATE_OK" = "true" ] \
  && [ "$VERIFY_RESULT" != "failure" ] \
  && [ "$EVAL_RESULT" != "failure" ] \
  && { [ "$VERIFY_RESULT" = "cancelled" ] || [ "$EVAL_RESULT" = "cancelled" ]; }; then
  if [ "$pr_state" != "open" ]; then
    echo "PR #${PR_NUMBER} is no longer open (state: ${pr_state}); skipping requeue."
    exit 0
  fi

  if [ "$current_sha" != "$HEAD_SHA" ]; then
    echo "PR #${PR_NUMBER} head SHA changed (${current_sha} != ${HEAD_SHA}); skipping requeue."
    exit 0
  fi

  if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
    next_attempt=$((attempt + 1))
    if gh workflow run dependency-bump.yml --repo "$GITHUB_REPOSITORY" --ref main -f "pr=${PR_NUMBER}" -f "attempt=${next_attempt}"; then
      set_status "pending" "Requeued after cancellation"
      echo "Requeued PR #${PR_NUMBER} (attempt ${next_attempt} of ${MAX_ATTEMPTS}) after cancellation."
      exit 0
    fi
    echo "::warning::Failed to requeue PR #${PR_NUMBER} after cancellation."
  fi

  set_status "pending" "Cancelled after ${attempt} attempt(s); rerun via workflow_dispatch"
  body="${MARKER}"$'\n'"Dependency bump verify/eval was cancelled at \`${HEAD_SHA}\` after ${attempt} attempt(s) and needs a manual rerun via \`workflow_dispatch\` (\`gh workflow run dependency-bump.yml -f pr=${PR_NUMBER}\`). See the [Dependency Bump run](${RUN_URL}).${security_note}"
  upsert_comment "$body"
  exit 0
fi

failed_stage=""
status_desc=""

if [ "$GATE_OK" != "true" ]; then
  if [[ "$GATE_REASON" == Template\ CI* ]]; then
    failed_stage="Template CI failed: ${GATE_REASON}"
    status_desc="Template CI did not pass"
  elif [[ "$GATE_REASON" == *"needs human review"* ]]; then
    failed_stage="${GATE_REASON}"
    status_desc="Needs human review"
  else
    failed_stage="Gate rejected PR: ${GATE_REASON}"
    status_desc="Gate check failed"
  fi
elif [ "$VERIFY_RESULT" != "success" ]; then
  failed_jobs=$(gh api --paginate "repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/jobs?per_page=100" \
    --jq '.jobs[] | select(.conclusion != null and .conclusion != "success" and .conclusion != "skipped") | select(.name | test("verify-")) | .name' \
    | paste -sd ", " - || true)
  if [ -n "$failed_jobs" ]; then
    failed_stage="Verify failed (${VERIFY_RESULT}): ${failed_jobs}"
  else
    failed_stage="Verify failed (${VERIFY_RESULT})"
  fi
  status_desc="Template CI verify failed"
else
  failed_jobs=$(gh api --paginate "repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/jobs?per_page=100" \
    --jq '.jobs[] | select(.conclusion != null and .conclusion != "success" and .conclusion != "skipped") | select(.name | test("^eval /")) | .name' \
    | paste -sd ", " - || true)
  if [ -n "$failed_jobs" ]; then
    failed_stage="Eval failed (${EVAL_RESULT}): ${failed_jobs}"
  else
    failed_stage="Eval failed (${EVAL_RESULT}) for templates ${TEMPLATES}"
  fi
  status_desc="Template eval failed"
fi

set_status "failure" "$status_desc"
body="${MARKER}"$'\n'"Dependency bump auto-merge blocked at \`${HEAD_SHA}\`."$'\n\n'"- **Failed stage**: ${failed_stage}"$'\n'"- **Run**: [Dependency Bump run](${RUN_URL})${security_note}"
upsert_comment "$body"
exit 1
