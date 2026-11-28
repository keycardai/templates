#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

REPO_ROOT="${REPO_ROOT:-.}"

emit_output() {
  local pr="$1"
  local head_sha="$2"
  local templates="$3"
  local ok="$4"
  local reason="${5//$'\n'/ }"
  {
    printf 'pr=%s\n' "$pr"
    printf 'head_sha=%s\n' "$head_sha"
    printf 'templates=%s\n' "$templates"
    printf 'ok=%s\n' "$ok"
    printf 'reason=%s\n' "$reason"
  } >> "$GITHUB_OUTPUT"
}

is_allowed_basename() {
  case "$1" in
    package.json|package-lock.json|pyproject.toml|uv.lock|go.mod|go.sum|build.gradle.kts|settings.gradle.kts|libs.versions.toml|gradle-wrapper.properties|Gemfile|Gemfile.lock)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_template_dir() {
  local dir="$1"
  case "$dir" in
    .github|eval|_skeleton|scripts)
      return 1
      ;;
  esac
  if [[ ! "$dir" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
    return 1
  fi
  if [ ! -d "${REPO_ROOT}/${dir}" ]; then
    return 1
  fi
  [ -f "${REPO_ROOT}/${dir}/package.json" ] \
    || [ -f "${REPO_ROOT}/${dir}/go.mod" ] \
    || [ -f "${REPO_ROOT}/${dir}/Gemfile" ] \
    || [ -f "${REPO_ROOT}/${dir}/build.gradle.kts" ] \
    || [ -f "${REPO_ROOT}/${dir}/pyproject.toml" ]
}

main() {
  local event_name="${EVENT_NAME:-}"
  local repo="${GITHUB_REPOSITORY:-}"
  local owner="${repo%%/*}"
  local pr_json=""
  local pr_number=""
  local pr_state=""
  local pr_author=""
  local pr_base_ref=""
  local pr_head_repo=""
  local pr_head_sha=""
  local target_sha=""

  if [ "$event_name" = "workflow_dispatch" ]; then
    local input_pr="${INPUT_PR:-}"
    if [[ ! "$input_pr" =~ ^[0-9]+$ ]]; then
      emit_output "" "" "[]" "false" "Invalid PR number: ${input_pr}"
      return 0
    fi
    if ! pr_json=$(gh api "repos/${repo}/pulls/${input_pr}"); then
      emit_output "" "" "[]" "false" "Could not fetch PR #${input_pr}"
      return 0
    fi
    pr_state=$(jq -r '.state // ""' <<< "$pr_json")
    if [ "$pr_state" != "open" ]; then
      emit_output "" "" "[]" "false" "PR #${input_pr} is not open (state: ${pr_state})"
      return 0
    fi
  elif [ "$event_name" = "workflow_run" ]; then
    local head_branch="${WORKFLOW_RUN_HEAD_BRANCH:-}"
    local run_head_sha="${WORKFLOW_RUN_HEAD_SHA:-}"
    local pulls_json=""
    if ! pulls_json=$(gh api "repos/${repo}/pulls?state=open&head=${owner}:${head_branch}&per_page=10"); then
      emit_output "" "" "[]" "false" "Could not list open PRs for branch ${head_branch}"
      return 0
    fi
    pr_json=$(jq -c --arg sha "$run_head_sha" '
      (map(select(.head.sha == $sha)) | .[0]) // .[0] // empty
    ' <<< "$pulls_json")
    if [ -z "$pr_json" ]; then
      emit_output "" "" "[]" "false" "No open PR found for branch ${head_branch}"
      return 0
    fi
  else
    emit_output "" "" "[]" "false" "Unsupported event: ${event_name}"
    return 0
  fi

  pr_number=$(jq -r '.number // ""' <<< "$pr_json")
  pr_author=$(jq -r '.user.login // ""' <<< "$pr_json")
  pr_base_ref=$(jq -r '.base.ref // ""' <<< "$pr_json")
  pr_head_repo=$(jq -r '.head.repo.full_name // ""' <<< "$pr_json")
  pr_head_sha=$(jq -r '.head.sha // ""' <<< "$pr_json")
  target_sha="$pr_head_sha"

  if [ "$event_name" = "workflow_run" ] && [ "$pr_head_sha" != "${WORKFLOW_RUN_HEAD_SHA:-}" ]; then
    emit_output "" "" "[]" "false" "Stale Template CI run: PR head SHA (${pr_head_sha}) no longer matches run head SHA (${WORKFLOW_RUN_HEAD_SHA:-})"
    return 0
  fi

  if [ "$pr_author" != "dependabot[bot]" ]; then
    emit_output "$pr_number" "$target_sha" "[]" "false" "PR author is ${pr_author}, expected dependabot[bot]"
    return 0
  fi

  if [ "$pr_base_ref" != "main" ]; then
    emit_output "$pr_number" "$target_sha" "[]" "false" "PR base branch is ${pr_base_ref}, expected main"
    return 0
  fi

  if [ "$pr_head_repo" != "$repo" ]; then
    emit_output "$pr_number" "$target_sha" "[]" "false" "PR head repository is ${pr_head_repo}, expected ${repo}"
    return 0
  fi

  local commits_lines=""
  if ! commits_lines=$(gh api --paginate "repos/${repo}/pulls/${pr_number}/commits?per_page=100" --jq '.[] | [(.author.login // "__MISSING__"), (.committer.login // "__MISSING__"), ((.commit.verification.verified // false) | tostring)] | @tsv'); then
    emit_output "$pr_number" "$target_sha" "[]" "false" "Could not fetch commits for PR #${pr_number}"
    return 0
  fi

  if [ -z "$commits_lines" ]; then
    emit_output "$pr_number" "$target_sha" "[]" "false" "PR has no commits"
    return 0
  fi

  local author="" committer="" verified=""
  while IFS=$'\t' read -r author committer verified; do
    if [ "$author" != "dependabot[bot]" ]; then
      local display_author="${author}"
      if [ "$display_author" = "__MISSING__" ]; then
        display_author="unknown"
      fi
      emit_output "$pr_number" "$target_sha" "[]" "false" "PR contains commit not authored by dependabot[bot] (author: ${display_author})"
      return 0
    fi
    if [ "$verified" != "true" ] || { [ "$committer" != "web-flow" ] && [ "$committer" != "dependabot[bot]" ]; }; then
      local display_committer="${committer}"
      if [ "$display_committer" = "__MISSING__" ]; then
        display_committer="unknown"
      fi
      emit_output "$pr_number" "$target_sha" "[]" "false" "PR contains unverified commit (committer: ${display_committer}, verified: ${verified})"
      return 0
    fi
  done <<< "$commits_lines"

  local files_lines=""
  if ! files_lines=$(gh api --paginate "repos/${repo}/pulls/${pr_number}/files?per_page=100" --jq '.[] | .filename, (.previous_filename // empty)'); then
    emit_output "$pr_number" "$target_sha" "[]" "false" "Could not fetch changed files for PR #${pr_number}"
    return 0
  fi

  local file_count=0
  local touched=()
  local file=""
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    file_count=$((file_count + 1))

    if [[ "$file" == /* || "$file" != */* || "$file" == *".."* ]]; then
      emit_output "$pr_number" "$target_sha" "[]" "false" "Changed file is outside a template directory: ${file}"
      return 0
    fi

    local top="${file%%/*}"
    local base="${file##*/}"

    case "$top" in
      .github|eval|_skeleton|scripts)
        emit_output "$pr_number" "$target_sha" "[]" "false" "Changed file is under disallowed directory ${top}: ${file}"
        return 0
        ;;
    esac

    if ! is_template_dir "$top"; then
      emit_output "$pr_number" "$target_sha" "[]" "false" "Changed file is not under an existing template directory: ${file}"
      return 0
    fi

    if ! is_allowed_basename "$base"; then
      emit_output "$pr_number" "$target_sha" "[]" "false" "Changed file is not an allowed dependency file: ${file}"
      return 0
    fi

    touched+=("$top")
  done <<< "$files_lines"

  if [ "$file_count" -eq 0 ]; then
    emit_output "$pr_number" "$target_sha" "[]" "false" "PR has no changed files"
    return 0
  fi

  local templates_json=""
  templates_json=$(printf '%s\n' "${touched[@]}" | sort -u | jq -R . | jq -sc .)

  local skip_file="${REPO_ROOT}/eval/eval-skip.txt"
  if [ -f "$skip_file" ]; then
    local skip_list=""
    skip_list=$(sed -e 's/#.*//' -e 's/[[:space:]]*$//' -e '/^$/d' "$skip_file")
    if [ -n "$skip_list" ]; then
      local skipped=()
      local tpl=""
      while IFS= read -r tpl; do
        if grep -qxF "$tpl" <<< "$skip_list"; then
          skipped+=("$tpl")
        fi
      done < <(jq -r '.[]' <<< "$templates_json")
      if [ "${#skipped[@]}" -gt 0 ]; then
        local skipped_joined=""
        skipped_joined=$(IFS=", "; echo "${skipped[*]}")
        emit_output "$pr_number" "$target_sha" "$templates_json" "false" "Template(s) listed in eval/eval-skip.txt cannot be auto-merged: ${skipped_joined}"
        return 0
      fi
    fi
  fi

  if [ "$event_name" = "workflow_run" ]; then
    local conclusion="${WORKFLOW_RUN_CONCLUSION:-}"
    local ci_url="${WORKFLOW_RUN_HTML_URL:-}"
    case "$conclusion" in
      success) ;;
      cancelled|skipped|stale)
        emit_output "" "" "$templates_json" "false" "Ignoring ${conclusion} Template CI run (${ci_url})"
        return 0
        ;;
      *)
        emit_output "$pr_number" "$target_sha" "$templates_json" "false" "Template CI concluded ${conclusion} (${ci_url})"
        return 0
        ;;
    esac
  else
    local ci_runs_json=""
    if ! ci_runs_json=$(gh api "repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${target_sha}&event=pull_request&per_page=20"); then
      emit_output "$pr_number" "$target_sha" "$templates_json" "false" "Could not look up Template CI runs for ${target_sha}"
      return 0
    fi
    local latest_run=""
    latest_run=$(jq -c '.workflow_runs | sort_by(.created_at) | reverse | .[0] // empty' <<< "$ci_runs_json")
    if [ -z "$latest_run" ]; then
      emit_output "$pr_number" "$target_sha" "$templates_json" "false" "No Template CI pull_request run found for ${target_sha}"
      return 0
    fi
    local ci_status=""
    local ci_conclusion=""
    local ci_url=""
    ci_status=$(jq -r '.status // ""' <<< "$latest_run")
    ci_conclusion=$(jq -r '.conclusion // ""' <<< "$latest_run")
    ci_url=$(jq -r '.html_url // ""' <<< "$latest_run")
    if [ "$ci_status" != "completed" ]; then
      emit_output "$pr_number" "$target_sha" "$templates_json" "false" "Template CI is still ${ci_status} (${ci_url})"
      return 0
    fi
    case "$ci_conclusion" in
      success) ;;
      cancelled|skipped|stale)
        emit_output "" "" "$templates_json" "false" "Ignoring ${ci_conclusion} Template CI run (${ci_url})"
        return 0
        ;;
      *)
        emit_output "$pr_number" "$target_sha" "$templates_json" "false" "Template CI concluded ${ci_conclusion} (${ci_url})"
        return 0
        ;;
    esac
  fi

  emit_output "$pr_number" "$target_sha" "$templates_json" "true" ""
}

main
