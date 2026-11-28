#!/usr/bin/env bash
set -o pipefail

previous_nightly_start() {
  local runs run attempt started eval_jobs
  runs=$(gh api --paginate \
    "repos/$GITHUB_REPOSITORY/actions/workflows/eval.yml/runs?event=schedule&status=success&branch=$GITHUB_REF_NAME&per_page=100" \
    --jq '.workflow_runs[] | select(.display_title == "Nightly Template Eval") | [.id, .run_attempt, .run_started_at] | @tsv') || return 1

  while IFS=$'\t' read -r run attempt started; do
    [[ -n "$run" && "$run" != "$GITHUB_RUN_ID" ]] || continue
    eval_jobs=$(gh api --paginate "repos/$GITHUB_REPOSITORY/actions/runs/$run/jobs?filter=all&per_page=100" \
      --jq '.jobs[] | select((.name | startswith("eval (")) and .conclusion == "success") | .name') || return 1
    [[ -n "$eval_jobs" ]] || continue

    if (( attempt > 1 )); then
      started=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$run/attempts/1" --jq '.run_started_at') || return 1
    fi
    [[ -n "$started" && "$started" != "null" ]] || return 1
    printf '%s\n' "$started"
    return 0
  done <<< "$runs"
}

latest_tag_dates() {
  gh api graphql --paginate -f name="$1" -f query='
    query($name: String!, $endCursor: String) {
      repository(owner: "keycardai", name: $name) {
        refs(refPrefix: "refs/tags/", first: 100, after: $endCursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            target {
              ... on Tag { tagger { date } }
              ... on Commit { committedDate }
            }
          }
        }
      }
    }' --jq '.data.repository.refs.nodes | map(.target.tagger.date // .target.committedDate // error("Missing tag date")) | max // empty'
}

finish() {
  printf 'run_eval=%s\n' "$1" >> "$GITHUB_OUTPUT"
  printf '### Nightly SDK release check\n\n%s\n' "$2" >> "$GITHUB_STEP_SUMMARY"
}

main() {
  local since sdk dates date
  if ! since=$(previous_nightly_start); then
    finish true "Could not read nightly eval history. Running the eval."
    return
  fi
  if [[ -z "$since" ]]; then
    finish true "No previous successful nightly eval was found. Running the eval."
    return
  fi

  for sdk in python-sdk typescript-sdk go-sdk ruby-sdk java-sdk; do
    if ! dates=$(latest_tag_dates "$sdk"); then
      finish true "Could not check keycardai/$sdk tags. Running the eval."
      return
    fi
    while IFS= read -r date; do
      if [[ "$date" > "$since" ]]; then
        finish true "Found a keycardai/$sdk tag dated $date, after the previous successful nightly eval started at $since. Running the eval."
        return
      fi
    done <<< "$dates"
  done

  finish false "Skipping all eval jobs: no Keycard SDK tags newer than the previous successful nightly eval start ($since)."
}

main
