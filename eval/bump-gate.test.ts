import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = resolve(REPO_ROOT, ".github/scripts/bump-gate.sh");
const SHA = "1111111111111111111111111111111111111111";
const BRANCH = "dependabot/gomod/mcp-server-go/keycard-abc";
const CI_URL = "https://github.com/keycardai/templates/actions/runs/999";

interface RunOptions {
  eventName?: "workflow_run" | "workflow_dispatch";
  inputPr?: string;
  runHeadSha?: string;
  runHeadBranch?: string;
  runConclusion?: string;
  runHtmlUrl?: string;
  repoRoot?: string;
  fixtures?: Record<string, unknown>;
}

function makePr(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    state: "open",
    user: { login: "dependabot[bot]" },
    base: { ref: "main" },
    head: {
      sha: SHA,
      ref: BRANCH,
      repo: { full_name: "keycardai/templates" },
    },
    ...overrides,
  };
}

function runGate(opts: RunOptions = {}) {
  const eventName = opts.eventName ?? "workflow_run";
  const defaultFixtures: Record<string, unknown> = {
    [`repos/keycardai/templates/pulls?state=open&head=keycardai:${BRANCH}&per_page=10`]: [makePr()],
    "repos/keycardai/templates/pulls/42": makePr(),
    "repos/keycardai/templates/pulls/42/commits?per_page=100": [
      { author: { login: "dependabot[bot]" } },
    ],
    "repos/keycardai/templates/pulls/42/files?per_page=100": [
      { filename: "mcp-server-go/go.mod" },
      { filename: "mcp-server-go/go.sum" },
    ],
    [`repos/keycardai/templates/actions/workflows/ci.yml/runs?head_sha=${SHA}&event=pull_request&per_page=20`]: {
      workflow_runs: [
        {
          id: 999,
          status: "completed",
          conclusion: "success",
          created_at: "2026-11-27T06:05:00Z",
          html_url: CI_URL,
        },
      ],
    },
    ...(opts.fixtures ?? {}),
  };

  const dir = mkdtempSync(join(tmpdir(), "bump-gate-test-"));
  try {
    const output = join(dir, "output");
    writeFileSync(output, "");
    execFileSync("bash", ["-c", BASH_MOCK], {
      env: {
        ...process.env,
        FIXTURES: JSON.stringify(defaultFixtures),
        SCRIPT_PATH: SCRIPT,
        REPO_ROOT: opts.repoRoot ?? REPO_ROOT,
        GITHUB_REPOSITORY: "keycardai/templates",
        GITHUB_OUTPUT: output,
        EVENT_NAME: eventName,
        INPUT_PR: opts.inputPr ?? "",
        WORKFLOW_RUN_HEAD_SHA: opts.runHeadSha ?? SHA,
        WORKFLOW_RUN_HEAD_BRANCH: opts.runHeadBranch ?? BRANCH,
        WORKFLOW_RUN_CONCLUSION: opts.runConclusion ?? "success",
        WORKFLOW_RUN_HTML_URL: opts.runHtmlUrl ?? CI_URL,
      },
    });
    const raw = readFileSync(output, "utf8").trim();
    const parsed: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const idx = line.indexOf("=");
      if (idx !== -1) {
        parsed[line.slice(0, idx)] = line.slice(idx + 1);
      }
    }
    return parsed;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BASH_MOCK = String.raw`
  gh() {
    [[ "$1" == api ]] || return 1
    shift
    local endpoint="" filter=""
    while (( $# )); do
      case "$1" in
        --paginate) shift ;;
        --jq) filter="$2"; shift 2 ;;
        *) endpoint="$1"; shift ;;
      esac
    done
    local payload
    payload=$(jq -ce --arg endpoint "$endpoint" '.[$endpoint] // error("Missing fixture: " + $endpoint)' <<< "$FIXTURES") || return 1
    if [[ -n "$filter" ]]; then
      jq -r "$filter" <<< "$payload"
    else
      printf '%s\n' "$payload"
    fi
  }
  export -f gh
  bash "$SCRIPT_PATH"
`;

test("passes for a valid Dependabot PR touching allowed files in a template", () => {
  const out = runGate();
  assert.equal(out.ok, "true");
  assert.equal(out.pr, "42");
  assert.equal(out.head_sha, SHA);
  assert.equal(out.templates, '["mcp-server-go"]');
  assert.equal(out.reason, "");
});

test("allows nested gradle dependency files and deduplicates templates", () => {
  const out = runGate({
    fixtures: {
      "repos/keycardai/templates/pulls/42/files?per_page=100": [
        { filename: "mcp-server-java/build.gradle.kts" },
        { filename: "mcp-server-java/settings.gradle.kts" },
        { filename: "mcp-server-java/gradle/libs.versions.toml" },
        { filename: "mcp-server-java/gradle/wrapper/gradle-wrapper.properties" },
      ],
    },
  });
  assert.equal(out.ok, "true");
  assert.equal(out.templates, '["mcp-server-java"]');
});

test("rejects non-dependabot PR author, non-main base, fork head repo, and head SHA mismatch", () => {
  const badAuthor = runGate({
    fixtures: {
      [`repos/keycardai/templates/pulls?state=open&head=keycardai:${BRANCH}&per_page=10`]: [
        makePr({ user: { login: "some-human" } }),
      ],
    },
  });
  assert.equal(badAuthor.ok, "false");
  assert.match(badAuthor.reason, /PR author/);

  const badBase = runGate({
    fixtures: {
      [`repos/keycardai/templates/pulls?state=open&head=keycardai:${BRANCH}&per_page=10`]: [
        makePr({ base: { ref: "release" } }),
      ],
    },
  });
  assert.equal(badBase.ok, "false");
  assert.match(badBase.reason, /PR base branch/);

  const badHeadRepo = runGate({
    fixtures: {
      [`repos/keycardai/templates/pulls?state=open&head=keycardai:${BRANCH}&per_page=10`]: [
        makePr({ head: { sha: SHA, ref: BRANCH, repo: { full_name: "attacker/templates" } } }),
      ],
    },
  });
  assert.equal(badHeadRepo.ok, "false");
  assert.match(badHeadRepo.reason, /PR head repository/);

  const badSha = runGate({
    runHeadSha: "2222222222222222222222222222222222222222",
  });
  assert.equal(badSha.ok, "false");
  assert.match(badSha.reason, /does not match Template CI run head SHA/);
});

test("rejects PR when any commit was authored by a human or has no GitHub author", () => {
  const human = runGate({
    fixtures: {
      "repos/keycardai/templates/pulls/42/commits?per_page=100": [
        { author: { login: "dependabot[bot]" } },
        { author: { login: "Larry-Osakwe" } },
      ],
    },
  });
  assert.equal(human.ok, "false");
  assert.match(human.reason, /not authored by dependabot\[bot\]/);

  const nullAuthor = runGate({
    fixtures: {
      "repos/keycardai/templates/pulls/42/commits?per_page=100": [
        { author: { login: "dependabot[bot]" } },
        { author: null },
      ],
    },
  });
  assert.equal(nullAuthor.ok, "false");
  assert.match(nullAuthor.reason, /not authored by dependabot\[bot\] \(author: unknown\)/);
});

test("rejects disallowed files, forbidden directories, root files, and renames from outside", () => {
  const disallowedCases = [
    [{ filename: "mcp-server-go/main.go" }],
    [{ filename: ".github/workflows/ci.yml" }],
    [{ filename: "eval/package.json" }],
    [{ filename: "_skeleton/package.json" }],
    [{ filename: "scripts/package.json" }],
    [{ filename: "package.json" }],
    [{ filename: "does-not-exist/package.json" }],
    [{ filename: "mcp-server-go/../.github/package.json" }],
    [{ filename: "mcp-server-go/go.mod", previous_filename: "eval/go.mod" }],
  ];

  for (const files of disallowedCases) {
    const out = runGate({
      fixtures: {
        "repos/keycardai/templates/pulls/42/files?per_page=100": files,
      },
    });
    assert.equal(out.ok, "false", `expected rejection for ${JSON.stringify(files)}`);
  }
});

test("rejects templates listed in eval/eval-skip.txt", () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "bump-gate-skip-"));
  try {
    mkdirSync(join(tmpRoot, "mcp-server-go"), { recursive: true });
    writeFileSync(join(tmpRoot, "mcp-server-go/go.mod"), "module example\n");
    mkdirSync(join(tmpRoot, "eval"), { recursive: true });
    writeFileSync(join(tmpRoot, "eval/eval-skip.txt"), "# comment\nmcp-server-go  # temporarily skipped\n");

    const out = runGate({ repoRoot: tmpRoot });
    assert.equal(out.ok, "false");
    assert.match(out.reason, /eval-skip\.txt/);
    assert.match(out.reason, /mcp-server-go/);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("rejects when Template CI did not conclude success", () => {
  const out = runGate({ runConclusion: "failure" });
  assert.equal(out.ok, "false");
  assert.equal(out.pr, "42");
  assert.match(out.reason, /Template CI concluded failure/);
  assert.match(out.reason, new RegExp(CI_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("workflow_dispatch checks the latest Template CI run for the PR head SHA", () => {
  const pass = runGate({ eventName: "workflow_dispatch", inputPr: "42" });
  assert.equal(pass.ok, "true");
  assert.equal(pass.pr, "42");
  assert.equal(pass.templates, '["mcp-server-go"]');

  const fail = runGate({
    eventName: "workflow_dispatch",
    inputPr: "42",
    fixtures: {
      [`repos/keycardai/templates/actions/workflows/ci.yml/runs?head_sha=${SHA}&event=pull_request&per_page=20`]: {
        workflow_runs: [
          {
            id: 998,
            status: "completed",
            conclusion: "success",
            created_at: "2026-11-27T06:00:00Z",
            html_url: "https://github.com/keycardai/templates/actions/runs/998",
          },
          {
            id: 1000,
            status: "completed",
            conclusion: "failure",
            created_at: "2026-11-27T06:10:00Z",
            html_url: "https://github.com/keycardai/templates/actions/runs/1000",
          },
        ],
      },
    },
  });
  assert.equal(fail.ok, "false");
  assert.match(fail.reason, /Template CI concluded failure/);
  assert.match(fail.reason, /runs\/1000/);
});

test("emits empty pr when no open PR exists for the workflow_run branch", () => {
  const out = runGate({
    fixtures: {
      [`repos/keycardai/templates/pulls?state=open&head=keycardai:${BRANCH}&per_page=10`]: [],
    },
  });
  assert.equal(out.ok, "false");
  assert.equal(out.pr, "");
});
