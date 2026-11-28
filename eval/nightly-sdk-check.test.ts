import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const history = "repos/keycardai/templates/actions/workflows/eval.yml/runs?event=schedule&status=success&branch=main&per_page=100";
const jobs = (id: number) => "repos/keycardai/templates/actions/runs/" + id + "/jobs?filter=all&per_page=100";
const since = "2026-11-25T09:00:00Z";
const newer = "2026-11-26T09:00:00Z";
const sdkNames = ["python-sdk", "typescript-sdk", "go-sdk", "ruby-sdk", "java-sdk"];

function refs(...targets: object[]) {
  return { data: { repository: { refs: { nodes: targets.map((target) => ({ target })) } } } };
}

function check(overrides: Record<string, unknown[] | null> = {}) {
  const fixtures = {
    [history]: [{
      workflow_runs: [
        { id: 10, display_title: "Nightly Template Eval", run_attempt: 1, run_started_at: "2026-11-28T09:00:00Z" },
        { id: 9, display_title: "Template Eval", run_attempt: 1, run_started_at: "2026-11-27T09:00:00Z" },
        { id: 8, display_title: "Nightly Template Eval", run_attempt: 1, run_started_at: newer },
        { id: 7, display_title: "Nightly Template Eval", run_attempt: 2, run_started_at: newer },
      ],
    }],
    [jobs(8)]: [{ jobs: [{ name: "eval (template)", conclusion: "skipped" }] }],
    [jobs(7)]: [{ jobs: [{ name: "eval (template)", conclusion: "success" }] }],
    "repos/keycardai/templates/actions/runs/7/attempts/1": [{ run_started_at: since }],
    ...Object.fromEntries(sdkNames.map((sdk) => [sdk, [refs({ committedDate: since })]])),
    ...overrides,
  };

  const dir = mkdtempSync(join(tmpdir(), "nightly-sdk-check-"));
  try {
    const output = join(dir, "output");
    const summary = join(dir, "summary");
    execFileSync("bash", ["-c", BASH_MOCK], {
      env: {
        ...process.env,
        FIXTURES: JSON.stringify(fixtures),
        GITHUB_REPOSITORY: "keycardai/templates",
        GITHUB_REF_NAME: "main",
        GITHUB_RUN_ID: "10",
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
      },
    });
    return {
      output: readFileSync(output, "utf8").trim(),
      summary: readFileSync(summary, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BASH_MOCK = String.raw`
  gh() {
    [[ "$1" == api ]] || return 1
    local endpoint= filter=
    shift
    while (( $# )); do
      case "$1" in
        --paginate) shift ;;
        --jq) filter="$2"; shift 2 ;;
        -f)
          if [[ "$2" == name=* ]]; then endpoint=$(cut -c6- <<< "$2"); fi
          shift 2
          ;;
        *) endpoint="$1"; shift ;;
      esac
    done
    jq -ce --arg endpoint "$endpoint" '.[$endpoint] // error("Unavailable API fixture") | .[]' <<< "$FIXTURES" |
      jq -r "$filter"
  }
  export -f gh
  bash nightly-sdk-check.sh
`;

test("skips an unchanged night without using a skipped, weekly, current, or rerun start time", () => {
  const result = check();
  assert.equal(result.output, "run_eval=false");
  assert.match(result.summary, /Skipping all eval jobs/);
  assert.ok(result.summary.includes(since));
});

test("runs when an SDK has a newer tag on a later API page", () => {
  const result = check({ "java-sdk": [refs({ committedDate: since }), refs({ tagger: { date: newer } })] });
  assert.equal(result.output, "run_eval=true");
  assert.match(result.summary, /Found a keycardai\/java-sdk tag/);
});

test("runs the first nightly eval", () => {
  const result = check({ [history]: [{ workflow_runs: [] }] });
  assert.equal(result.output, "run_eval=true");
  assert.match(result.summary, /No previous successful nightly eval/);
});

test("runs when the GitHub API cannot check history or SDK tags", () => {
  const result = check({ [history]: null });
  assert.equal(result.output, "run_eval=true");
  assert.match(result.summary, /Could not read nightly eval history/);
  const tags = check({ "typescript-sdk": null });
  assert.equal(tags.output, "run_eval=true");
  assert.match(tags.summary, /Could not check keycardai\/typescript-sdk tags/);
});
