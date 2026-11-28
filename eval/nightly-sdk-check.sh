#!/usr/bin/env bash
set -o pipefail
export LC_ALL=C

previous_nightly_run() {
  local runs run eval_jobs
  runs=$(gh api --paginate \
    "repos/$GITHUB_REPOSITORY/actions/workflows/eval.yml/runs?event=schedule&status=success&branch=$GITHUB_REF_NAME&per_page=100" \
    --jq '.workflow_runs[] | select(.display_title == "Nightly Template Eval") | .id') || return 1

  while IFS= read -r run; do
    [[ -n "$run" && "$run" != "$GITHUB_RUN_ID" ]] || continue
    eval_jobs=$(gh api --paginate "repos/$GITHUB_REPOSITORY/actions/runs/$run/jobs?filter=all&per_page=100" \
      --jq '.jobs[] | select((.name | startswith("eval (")) and .conclusion == "success") | .name') || return 1
    [[ -n "$eval_jobs" ]] || continue

    printf '%s\n' "$run"
    return 0
  done <<< "$runs"
}

list_tags() {
  local sdk
  for sdk in python-sdk typescript-sdk go-sdk ruby-sdk java-sdk; do
    gh api graphql --paginate -f name="$sdk" -f query='
    query($name: String!, $endCursor: String) {
      repository(owner: "keycardai", name: $name) {
        refs(refPrefix: "refs/tags/", first: 100, after: $endCursor) {
          pageInfo { hasNextPage endCursor }
          nodes { name }
        }
      }
    }' --jq '.data.repository.refs.nodes[].name' |
      sed "s|^|keycardai/$sdk |" || return 1
  done
}

new_tags() (
  dir=$(mktemp -d) || return 1
  trap 'rm -rf -- "$dir"' EXIT
  gh run download "$1" --repo "$GITHUB_REPOSITORY" --name sdk-tags --dir "$dir" || return 1
  previous_snapshot="$dir/sdk-tags.txt"
  sort -cu "$previous_snapshot" || return 1
  comm -13 "$previous_snapshot" "$SDK_TAGS_FILE"
)

finish() {
  printf 'run_eval=%s\n' "$1" >> "$GITHUB_OUTPUT"
  printf '### Nightly SDK release check\n\n%s\n' "$2" >> "$GITHUB_STEP_SUMMARY"
}

main() {
  local previous added
  if ! list_tags | sort -u > "$SDK_TAGS_FILE"; then
    finish true "Could not list all Keycard SDK tags. Running the eval."
    return
  fi
  printf 'tags_ready=true\n' >> "$GITHUB_OUTPUT"

  if ! previous=$(previous_nightly_run); then
    finish true "Could not read nightly eval history. Running the eval."
    return
  fi
  if [[ -z "$previous" ]]; then
    finish true "No previous successful nightly eval was found. Running the eval."
    return
  fi

  if ! added=$(new_tags "$previous"); then
    finish true "Could not read the SDK tag snapshot from nightly run $previous. Running the eval."
    return
  fi
  if [[ -n "$added" ]]; then
    finish true "Found new Keycard SDK tags since nightly run $previous. Running the eval."
    printf '\n' >> "$GITHUB_STEP_SUMMARY"
    sed 's/^/    /' <<< "$added" >> "$GITHUB_STEP_SUMMARY"
    return
  fi
  finish false "Skipping all eval jobs: no new Keycard SDK tags since nightly run $previous."
}

main
