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
  local automerge="${6:-false}"
  local automerge_reason="${7:-}"
  automerge_reason="${automerge_reason//$'\n'/ }"
  {
    printf 'pr=%s\n' "$pr"
    printf 'head_sha=%s\n' "$head_sha"
    printf 'templates=%s\n' "$templates"
    printf 'ok=%s\n' "$ok"
    printf 'reason=%s\n' "$reason"
    printf 'automerge=%s\n' "$automerge"
    printf 'automerge_reason=%s\n' "$automerge_reason"
  } >> "$GITHUB_OUTPUT"
}

detect_ecosystem() {
  local head_ref="$1"
  local templates_json="$2"
  if [[ "$head_ref" =~ ^dependabot/([^/]+)/ ]]; then
    case "${BASH_REMATCH[1]}" in
      npm_and_yarn) echo "npm"; return 0 ;;
      uv|pip) echo "uv"; return 0 ;;
      go_modules|gomod) echo "gomod"; return 0 ;;
      gradle) echo "gradle"; return 0 ;;
    esac
  fi

  local eco=""
  local tpl=""
  while IFS= read -r tpl; do
    local tpl_eco=""
    if [ -f "${REPO_ROOT}/${tpl}/package.json" ]; then
      tpl_eco="npm"
    elif [ -f "${REPO_ROOT}/${tpl}/go.mod" ]; then
      tpl_eco="gomod"
    elif [ -f "${REPO_ROOT}/${tpl}/build.gradle.kts" ]; then
      tpl_eco="gradle"
    elif [ -f "${REPO_ROOT}/${tpl}/pyproject.toml" ]; then
      tpl_eco="uv"
    else
      return 1
    fi
    if [ -z "$eco" ]; then
      eco="$tpl_eco"
    elif [ "$eco" != "$tpl_eco" ]; then
      return 1
    fi
  done < <(jq -r '.[]' <<< "$templates_json")
  [ -n "$eco" ] || return 1
  echo "$eco"
}

is_keycard_dependency() {
  local eco="$1"
  local dep="$2"
  case "$eco" in
    npm)
      [[ "$dep" =~ ^@keycardai/[A-Za-z0-9._-]+$ ]]
      ;;
    uv)
      [[ "$dep" =~ ^keycardai-[A-Za-z0-9._-]+$ ]]
      ;;
    gomod)
      [[ "$dep" =~ ^github\.com/keycardai/[A-Za-z0-9._/-]+$ ]]
      ;;
    gradle)
      [[ "$dep" =~ ^ai\.keycard:[A-Za-z0-9._-]+$ ]]
      ;;
    *)
      return 1
      ;;
  esac
}

load_metadata_json() {
  local repo="$1"
  local ci_run_id="$2"

  if [ -n "${METADATA_FILE:-}" ]; then
    [ -f "$METADATA_FILE" ] || return 1
    cat "$METADATA_FILE"
    return 0
  fi

  [ -n "$ci_run_id" ] || return 1
  local artifacts_json=""
  artifacts_json=$(gh api "repos/${repo}/actions/runs/${ci_run_id}/artifacts?per_page=100") || return 1
  local artifact_id=""
  artifact_id=$(jq -r '
    .artifacts
    | map(select(.name == "dependabot-metadata" and (.expired // false) == false))
    | sort_by(.created_at) | reverse | .[0].id // ""
  ' <<< "$artifacts_json")
  [ -n "$artifact_id" ] || return 1

  local tmp_zip=""
  tmp_zip=$(mktemp)
  if ! gh api "repos/${repo}/actions/artifacts/${artifact_id}/zip" > "$tmp_zip"; then
    rm -f "$tmp_zip"
    return 1
  fi
  local content=""
  if ! content=$(unzip -p "$tmp_zip" dependabot-metadata.json 2>/dev/null); then
    rm -f "$tmp_zip"
    return 1
  fi
  rm -f "$tmp_zip"
  printf '%s\n' "$content"
}

parse_commit_metadata_json() {
  local target_sha="$1"
  local message="$2"

  local rows=""
  rows=$(awk '
    function trim(s) {
      sub(/^[[:space:]]+/, "", s)
      sub(/[[:space:]]+$/, "", s)
      if ((substr(s, 1, 1) == "\"" && substr(s, length(s), 1) == "\"") ||
          (substr(s, 1, 1) == "\x27" && substr(s, length(s), 1) == "\x27")) {
        s = substr(s, 2, length(s) - 2)
      }
      return s
    }
    function flush_item() {
      if (in_item) {
        printf "%s\t%s\n", dep_name, update_type
        dep_name = ""
        update_type = ""
        in_item = 0
      }
    }
    {
      line = $0
      sub(/\r$/, "", line)
      if (!in_block) {
        if (saw_sep && line ~ /^updated-dependencies:[[:space:]]*$/) {
          in_block = 1
          saw_sep = 0
          next
        }
        saw_sep = (line ~ /^---[[:space:]]*$/) ? 1 : 0
        next
      }
      if (line ~ /^\.\.\.[[:space:]]*$/ || line ~ /^---[[:space:]]*$/) {
        flush_item()
        exit
      }
      if (line ~ /^[[:space:]]*-[[:space:]]+/) {
        flush_item()
        in_item = 1
        sub(/^[[:space:]]*-[[:space:]]+/, "", line)
      } else if (!in_item) {
        next
      }
      idx = index(line, ":")
      if (idx > 0) {
        key = trim(substr(line, 1, idx - 1))
        val = trim(substr(line, idx + 1))
        if (key == "dependency-name") {
          dep_name = val
        } else if (key == "update-type") {
          update_type = val
        }
      }
    }
    END {
      if (in_block) {
        flush_item()
      }
    }
  ' <<< "$message")

  [ -n "$rows" ] || return 1

  local deps=()
  local max_rank=0
  local has_unknown="false" has_reported_type="false"
  local dep_name="" update_type=""
  while IFS=$'\t' read -r dep_name update_type; do
    if [ -z "$dep_name" ]; then
      return 1
    fi
    deps+=("$dep_name")
    if [ -n "$update_type" ]; then has_reported_type="true"; fi
    case "$update_type" in
      version-update:semver-patch)
        if [ "$max_rank" -lt 1 ]; then max_rank=1; fi
        ;;
      version-update:semver-minor)
        if [ "$max_rank" -lt 2 ]; then max_rank=2; fi
        ;;
      version-update:semver-major)
        if [ "$max_rank" -lt 3 ]; then max_rank=3; fi
        ;;
      *)
        has_unknown="true"
        ;;
    esac
  done <<< "$rows"

  [ "${#deps[@]}" -gt 0 ] || return 1

  local highest_type=""
  if [ "$has_unknown" != "true" ]; then
    case "$max_rank" in
      3) highest_type="version-update:semver-major" ;;
      2) highest_type="version-update:semver-minor" ;;
      1) highest_type="version-update:semver-patch" ;;
    esac
  fi

  local joined_deps=""
  local old_ifs="$IFS"
  IFS=','
  joined_deps="${deps[*]}"
  IFS="$old_ifs"

  jq -n \
    --arg head_sha "$target_sha" \
    --arg dependency_names "$joined_deps" \
    --arg update_type "$highest_type" \
    --argjson has_reported_type "$has_reported_type" \
    '{head_sha: $head_sha, dependency_names: $dependency_names, update_type: $update_type,
      has_reported_type: $has_reported_type}'
}

load_verified_commit_json() {
  local repo="$1"
  local target_sha="$2"
  local commit_json=""
  commit_json=$(gh api "repos/${repo}/commits/${target_sha}") || return 1

  local author="" committer="" verified=""
  author=$(jq -r '.author.login // ""' <<< "$commit_json")
  committer=$(jq -r '.committer.login // ""' <<< "$commit_json")
  verified=$(jq -r '(.commit.verification.verified // false) | tostring' <<< "$commit_json")

  if [ "$author" != "dependabot[bot]" ] || [ "$verified" != "true" ] || { [ "$committer" != "web-flow" ] && [ "$committer" != "dependabot[bot]" ]; }; then
    return 1
  fi

  printf '%s\n' "$commit_json"
}

python_manifest_file() {
  jq -sec '
    select(all(.[]; .previous_filename == null and (.filename | test("/(pyproject\\.toml|uv\\.lock)$"))))
    | map(select(.filename | endswith("/pyproject.toml")))
    | select(length == 1) | .[0]
  '
}

infer_python_floor_update_type() {
  local repo="$1" target_sha="$2" dep="$3" files_json="$4" commit_json="$5" commit_count="$6"
  local dep_pattern='[A-Za-z0-9_.-]+(\[[A-Za-z0-9_.,-]+\])?'
  [[ "$dep" =~ ^${dep_pattern}$ ]] || return 1

  local manifest="" patch=""
  manifest=$(python_manifest_file <<< "$files_json") || return 1
  patch=$(jq -r '.patch // ""' <<< "$manifest")
  if [ -z "$patch" ]; then
    # The head commit alone represents the entire PR only for a single-commit update.
    [ "$commit_count" -eq 1 ] || return 1
    if [ -z "$commit_json" ]; then
      commit_json=$(load_verified_commit_json "$repo" "$target_sha") || return 1
    fi
    local commit_manifest="" filename=""
    commit_manifest=$(jq -c '.files[]?' <<< "$commit_json" | python_manifest_file) || return 1
    filename=$(jq -r '.filename' <<< "$manifest")
    patch=$(jq -er --arg filename "$filename" 'select(.filename == $filename) | .patch // empty' <<< "$commit_manifest") || return 1
  fi

  local release='[0-9]{1,9}(\.[0-9]{1,9}){0,2}'
  local old="" new=""
  local changes=()
  mapfile -t changes < <(sed -n '/^[-+]/p' <<< "$patch")
  local upper_bound="[[:space:]]*,[[:space:]]*<=?[[:space:]]*${release}"
  local requirement="^[[:space:]]*\"(${dep_pattern})[[:space:]]*>=[[:space:]]*(${release})(${upper_bound})?[[:space:]]*\"[[:space:]]*,?[[:space:]]*$"
  [ "${#changes[@]}" -eq 2 ] || return 1
  [[ "${changes[0]}" == -* && "${changes[0]:1}" =~ $requirement && "${BASH_REMATCH[1]}" == "$dep" ]] || return 1
  old="${BASH_REMATCH[3]}"
  local upper="${BASH_REMATCH[5]}"
  [[ "${changes[1]}" == +* && "${changes[1]:1}" =~ $requirement && "${BASH_REMATCH[1]}" == "$dep" ]] || return 1
  new="${BASH_REMATCH[3]}"
  [ "$upper" = "${BASH_REMATCH[5]}" ] || return 1

  local old_major old_minor old_patch new_major new_minor new_patch
  IFS=. read -r old_major old_minor old_patch <<< "$old"
  IFS=. read -r new_major new_minor new_patch <<< "$new"
  old_minor=${old_minor:-0}
  new_minor=${new_minor:-0}
  old_patch=${old_patch:-0}
  new_patch=${new_patch:-0}

  if (( 10#$new_major > 10#$old_major )); then
    echo "version-update:semver-major"
  elif (( 10#$new_major == 10#$old_major )); then
    if (( 10#$new_minor > 10#$old_minor )); then
      if (( 10#$old_major == 0 )); then
        echo "version-update:semver-major"
      else
        echo "version-update:semver-minor"
      fi
    elif (( 10#$new_minor == 10#$old_minor && 10#$new_patch > 10#$old_patch )); then
      echo "version-update:semver-patch"
    else
      return 1
    fi
  else
    return 1
  fi
}

evaluate_automerge() {
  local repo="$1"
  local ci_run_id="$2"
  local pr_head_ref="$3"
  local target_sha="$4"
  local templates_json="$5"
  local files_json="$6"
  local commit_count="$7"

  # Security update PRs (security group branch) auto-merge at any level when green.
  if [[ "$pr_head_ref" =~ ^dependabot/[^/]+/[^/]+/security(-|$) ]]; then
    AUTOMERGE_DECISION="true"
    AUTOMERGE_REASON=""
    return 0
  fi

  local meta_json="" commit_json=""
  if ! meta_json=$(load_metadata_json "$repo" "$ci_run_id"); then
    local commit_message=""
    if ! commit_json=$(load_verified_commit_json "$repo" "$target_sha") ||
      ! commit_message=$(jq -r '.commit.message // ""' <<< "$commit_json") ||
      ! meta_json=$(parse_commit_metadata_json "$target_sha" "$commit_message"); then
      AUTOMERGE_DECISION="false"
      AUTOMERGE_REASON="Dependabot metadata missing; treating as major for human review"
      return 0
    fi
  fi

  if ! jq -e 'type == "object"' <<< "$meta_json" >/dev/null 2>&1; then
    AUTOMERGE_DECISION="false"
    AUTOMERGE_REASON="Dependabot metadata artifact is invalid JSON; treating as major for human review"
    return 0
  fi

  local meta_sha=""
  local update_type=""
  local dependency_names=""
  meta_sha=$(jq -r '.head_sha // ""' <<< "$meta_json")
  update_type=$(jq -r '.update_type // ""' <<< "$meta_json")
  dependency_names=$(jq -r '.dependency_names // ""' <<< "$meta_json")

  if [ "$meta_sha" != "$target_sha" ]; then
    AUTOMERGE_DECISION="false"
    AUTOMERGE_REASON="Dependabot metadata head SHA mismatch; treating as major for human review"
    return 0
  fi

  local eco=""
  eco=$(detect_ecosystem "$pr_head_ref" "$templates_json" || true)

  local dep_count=0
  local all_keycard="true"
  local dep=""
  if [ -n "$dependency_names" ]; then
    local old_ifs="$IFS"
    IFS=','
    for dep in $dependency_names; do
      IFS="$old_ifs"
      dep=$(sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' <<< "$dep")
      if [ -z "$dep" ]; then
        continue
      fi
      dep_count=$((dep_count + 1))
      if [ -z "$eco" ] || ! is_keycard_dependency "$eco" "$dep"; then
        all_keycard="false"
      fi
    done
    IFS="$old_ifs"
  fi

  if [ "$dep_count" -gt 0 ] && [ "$all_keycard" = "true" ]; then
    AUTOMERGE_DECISION="true"
    AUTOMERGE_REASON=""
    return 0
  fi

  if [ "$eco" = "uv" ] && [ -z "$update_type" ] &&
    jq -e '.has_reported_type != true' <<< "$meta_json" >/dev/null; then
    update_type=$(infer_python_floor_update_type "$repo" "$target_sha" "$dependency_names" "$files_json" "$commit_json" "$commit_count") || update_type=""
  fi

  case "$update_type" in
    version-update:semver-patch|version-update:semver-minor)
      AUTOMERGE_DECISION="true"
      AUTOMERGE_REASON=""
      return 0
      ;;
    version-update:semver-major)
      AUTOMERGE_DECISION="false"
      AUTOMERGE_REASON="Third-party semver-major update needs human review"
      return 0
      ;;
    *)
      AUTOMERGE_DECISION="false"
      AUTOMERGE_REASON="Unknown or mixed update type (${update_type:-missing}); treating as major for human review"
      return 0
      ;;
  esac
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
  pr_head_ref=$(jq -r '.head.ref // ""' <<< "$pr_json")
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

  local author="" committer="" verified="" commit_count=0
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
    commit_count=$((commit_count + 1))
  done <<< "$commits_lines"

  local files_json="" files_lines=""
  if ! files_json=$(gh api --paginate "repos/${repo}/pulls/${pr_number}/files?per_page=100" --jq '
    .[] | {filename, previous_filename, patch: (if .filename | endswith("/pyproject.toml") then .patch else null end)} | @json
  '); then
    emit_output "$pr_number" "$target_sha" "[]" "false" "Could not fetch changed files for PR #${pr_number}"
    return 0
  fi
  files_lines=$(jq -r '.filename, (.previous_filename // empty)' <<< "$files_json")

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

    case "$base" in
      gradlew|gradlew.bat|gradle-wrapper.jar)
        emit_output "$pr_number" "$target_sha" "[]" "false" "Gradle wrapper file needs human review: ${file}"
        return 0
        ;;
    esac

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

  local ci_run_id=""
  if [ "$event_name" = "workflow_run" ]; then
    local conclusion="${WORKFLOW_RUN_CONCLUSION:-}"
    local ci_url="${WORKFLOW_RUN_HTML_URL:-}"
    ci_run_id="${WORKFLOW_RUN_ID:-}"
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
    ci_run_id=$(jq -r '.id // ""' <<< "$latest_run")
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

  AUTOMERGE_DECISION="false"
  AUTOMERGE_REASON=""
  evaluate_automerge "$repo" "$ci_run_id" "$pr_head_ref" "$target_sha" "$templates_json" "$files_json" "$commit_count"

  emit_output "$pr_number" "$target_sha" "$templates_json" "true" "" "$AUTOMERGE_DECISION" "$AUTOMERGE_REASON"
}

main
