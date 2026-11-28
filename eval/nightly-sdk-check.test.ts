import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const history = "repos/keycardai/templates/actions/workflows/eval.yml/runs?event=schedule&status=success&branch=main&per_page=100";
const jobs = (id: number) => "repos/keycardai/templates/actions/runs/" + id + "/jobs?filter=all&per_page=100";
const sdkNames = ["python-sdk", "typescript-sdk", "go-sdk", "ruby-sdk", "java-sdk"];
const snapshot = sdkNames.map((sdk) => "keycardai/" + sdk + " v1.0.0\n").sort().join("");

function refs(...names: string[]) {
  return { data: { repository: { refs: { nodes: names.map((name) => ({ name })) } } } };
}

function check(overrides: Record<string, unknown[] | string | null> = {}) {
  const fixtures = {
    [history]: [{
      workflow_runs: [
        { id: 10, display_title: "Nightly Template Eval" },
        { id: 9, display_title: "Template Eval" },
        { id: 8, display_title: "Nightly Template Eval" },
        { id: 7, display_title: "Nightly Template Eval" },
      ],
    }],
    [jobs(8)]: [{ jobs: [{ name: "eval (template)", conclusion: "skipped" }] }],
    [jobs(7)]: [{ jobs: [{ name: "eval (template)", conclusion: "success" }] }],
    "artifact:7": snapshot,
    ...Object.fromEntries(sdkNames.map((sdk) => [sdk, [refs("v1.0.0")]])),
    ...overrides,
  };

  const dir = mkdtempSync(join(tmpdir(), "nightly-sdk-check-"));
  try {
    const output = join(dir, "output");
    const summary = join(dir, "summary");
    const tags = join(dir, "sdk-tags.txt");
    execFileSync("bash", ["-c", BASH_MOCK], {
      env: {
        ...process.env,
        FIXTURES: JSON.stringify(fixtures),
        GITHUB_REPOSITORY: "keycardai/templates",
        GITHUB_REF_NAME: "main",
        GITHUB_RUN_ID: "10",
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        SDK_TAGS_FILE: tags,
      },
    });
    return {
      output: readFileSync(output, "utf8").trim(),
      summary: readFileSync(summary, "utf8"),
      tags: readFileSync(tags, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BASH_MOCK = String.raw`
  gh() {
    if [[ "$1" == run && "$2" == download ]]; then
      [[ "$4 $5 $6 $7 $8" == "--repo keycardai/templates --name sdk-tags --dir" ]] || return 1
      jq -jer --arg key "artifact:$3" '.[$key]' <<< "$FIXTURES" > "$9/sdk-tags.txt"
      return
    fi
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

test("skips an unchanged night, using the last evaluated nightly and ignoring deleted tags", () => {
  const previous = [...snapshot.trimEnd().split("\n"), "keycardai/typescript-sdk v0.1.0"].sort().join("\n") + "\n";
  const result = check({ "artifact:7": previous });
  assert.equal(result.output, "tags_ready=true\nrun_eval=false");
  assert.match(result.summary, /Skipping all eval jobs/);
  assert.match(result.summary, /nightly run 7/);
  assert.equal(result.tags, snapshot);
});

test("runs and names new tags on later API pages, even if the version exists in another repo", () => {
  const result = check({ "java-sdk": [refs("v1.0.0"), refs("v1.1.0", "v1.0.0")], "go-sdk": [refs("v1.1.0", "v1.0.0")] });
  assert.equal(result.output, "tags_ready=true\nrun_eval=true");
  assert.match(result.summary, /Found new Keycard SDK tags/);
  assert.match(result.summary, /^    keycardai\/go-sdk v1\.1\.0$/m);
  assert.match(result.summary, /^    keycardai\/java-sdk v1\.1\.0$/m);
  assert.equal(result.tags.match(/keycardai\/java-sdk v1\.0\.0/g)?.length, 1);
});

test("runs the first nightly eval", () => {
  const result = check({ [history]: [{ workflow_runs: [] }] });
  assert.equal(result.output, "tags_ready=true\nrun_eval=true");
  assert.match(result.summary, /No previous successful nightly eval/);
});

test("runs when the previous tag artifact is missing or unreadable", () => {
  for (const artifact of [null, "keycardai/ruby-sdk v1.0.0\nkeycardai/go-sdk v1.0.0\n"]) {
    const result = check({ "artifact:7": artifact });
    assert.equal(result.output, "tags_ready=true\nrun_eval=true");
    assert.match(result.summary, /Could not read the SDK tag snapshot from nightly run 7/);
  }
});

test("runs when the GitHub API cannot check history or SDK tags", () => {
  const result = check({ [history]: null });
  assert.equal(result.output, "tags_ready=true\nrun_eval=true");
  assert.match(result.summary, /Could not read nightly eval history/);
  const tags = check({ "typescript-sdk": null });
  assert.equal(tags.output, "run_eval=true");
  assert.match(tags.summary, /Could not list all Keycard SDK tags/);
});
