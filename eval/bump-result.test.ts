import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = resolve(REPO_ROOT, ".github/scripts/bump-result.sh");
const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RUN_URL = "https://github.com/keycardai/templates/actions/runs/46103189136";
const CI_WORKFLOW_URL = "https://github.com/keycardai/templates/actions/workflows/ci.yml";

interface ResultOptions {
  gateOk?: string;
  gateReason?: string;
  verifyResult?: string;
  evalResult?: string;
  attempt?: string;
  pr?: Record<string, unknown>;
  comments?: Array<{ id: number; body: string }>;
  jobs?: Array<{ name: string; conclusion: string | null; steps?: Array<{ name: string }> }>;
}

function runResult(opts: ResultOptions = {}) {
  const pr = {
    number: 80,
    state: "open",
    title: "chore(deps): bump the keycard group in /mcp-server-typescript-express",
    body: "Dependabot will resolve any conflicts with this PR. Dependabot security updates boilerplate.",
    labels: [{ name: "dependencies" }],
    head: {
      sha: SHA,
      ref: "dependabot/npm_and_yarn/mcp-server-typescript-express/keycard-abc123",
    },
    ...(opts.pr ?? {}),
  };

  const fixtures: Record<string, unknown> = {
    "repos/keycardai/templates/pulls/80": pr,
    "repos/keycardai/templates/issues/80/comments?per_page=100": opts.comments ?? [],
    "repos/keycardai/templates/actions/runs/46103189136/jobs?per_page=100": {
      jobs: opts.jobs ?? [],
    },
  };

  const dir = mkdtempSync(join(tmpdir(), "bump-result-test-"));
  try {
    const logFile = join(dir, "calls.jsonl");
    writeFileSync(logFile, "");
    const proc = spawnSync("bash", ["-c", BASH_MOCK], {
      encoding: "utf8",
      env: {
        ...process.env,
        FIXTURES: JSON.stringify(fixtures),
        CALLS_LOG: logFile,
        SCRIPT_PATH: SCRIPT,
        GITHUB_REPOSITORY: "keycardai/templates",
        GITHUB_RUN_ID: "46103189136",
        PR_NUMBER: "80",
        HEAD_SHA: SHA,
        TEMPLATES: '["mcp-server-typescript-express"]',
        GATE_OK: opts.gateOk ?? "true",
        GATE_REASON: opts.gateReason ?? "",
        VERIFY_RESULT: opts.verifyResult ?? "success",
        EVAL_RESULT: opts.evalResult ?? "success",
        ATTEMPT: opts.attempt ?? "1",
        RUN_URL,
        CI_WORKFLOW_URL,
      },
    });
    const rawLog = readFileSync(logFile, "utf8").trim();
    const calls = rawLog ? rawLog.split("\n").map((line) => JSON.parse(line)) : [];
    return {
      status: proc.status,
      stdout: proc.stdout,
      stderr: proc.stderr,
      calls,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BASH_MOCK = String.raw`
  gh() {
    local sub="$1"
    shift
    if [[ "$sub" == workflow && "$1" == run ]]; then
      shift
      jq -nc --args '$ARGS.positional | {cmd: "workflow_run", args: .}' -- "$@" >> "$CALLS_LOG"
      return 0
    fi
    if [[ "$sub" == pr && "$1" == merge ]]; then
      shift
      jq -nc --args '$ARGS.positional | {cmd: "pr_merge", args: .}' -- "$@" >> "$CALLS_LOG"
      return 0
    fi
    [[ "$sub" == api ]] || return 1
    local method="GET" endpoint="" filter=""
    local fields=()
    while (( $# )); do
      case "$1" in
        --paginate) shift ;;
        -X) method="$2"; shift 2 ;;
        --jq) filter="$2"; shift 2 ;;
        -f) fields+=("$2"); shift 2 ;;
        *) endpoint="$1"; shift ;;
      esac
    done
    if [[ "$method" != "GET" ]]; then
      jq -nc --arg method "$method" --arg endpoint "$endpoint" --args \
        '{cmd: "api", method: $method, endpoint: $endpoint, fields: $ARGS.positional}' \
        -- "` + '${fields[@]}' + String.raw`" >> "$CALLS_LOG"
      echo '{}'
      return 0
    fi
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

test("requeues cancelled eval on attempt 1 with pending status and no red comment", () => {
  const res = runResult({ verifyResult: "success", evalResult: "cancelled", attempt: "1" });
  assert.equal(res.status, 0);
  const dispatch = res.calls.find((c) => c.cmd === "workflow_run");
  assert.ok(dispatch, "expected workflow_run requeue");
  assert.deepEqual(dispatch.args, [
    "dependency-bump.yml",
    "--repo",
    "keycardai/templates",
    "--ref",
    "main",
    "-f",
    "pr=80",
    "-f",
    "attempt=2",
  ]);
  const statusCall = res.calls.find((c) => c.cmd === "api" && c.endpoint.includes("/statuses/"));
  assert.ok(statusCall, "expected pending status call");
  assert.ok(statusCall.fields.includes("state=pending"));
  assert.ok(statusCall.fields.includes("description=Requeued after cancellation"));
  const commentCall = res.calls.find((c) => c.cmd === "api" && c.endpoint.includes("/comments"));
  assert.equal(commentCall, undefined);
});

test("requeues cancelled verify on attempt 2 as attempt 3", () => {
  const res = runResult({ verifyResult: "cancelled", evalResult: "skipped", attempt: "2" });
  assert.equal(res.status, 0);
  const dispatch = res.calls.find((c) => c.cmd === "workflow_run");
  assert.ok(dispatch);
  assert.ok(dispatch.args.includes("attempt=3"));
});

test("after 3 cancelled attempts, posts a neutral manual-rerun comment with no failure status", () => {
  const res = runResult({ verifyResult: "success", evalResult: "cancelled", attempt: "3" });
  assert.equal(res.status, 0);
  assert.equal(res.calls.find((c) => c.cmd === "workflow_run"), undefined);
  const statusCall = res.calls.find((c) => c.cmd === "api" && c.endpoint.includes("/statuses/"));
  assert.ok(statusCall, "expected pending status update");
  assert.ok(statusCall.fields.includes("state=pending"));
  assert.ok(statusCall.fields.includes("description=Cancelled after 3 attempt(s); rerun via workflow_dispatch"));
  const commentCall = res.calls.find((c) => c.cmd === "api" && c.endpoint.includes("/comments"));
  assert.ok(commentCall, "expected neutral comment");
  const bodyField = commentCall.fields.find((f: string) => f.startsWith("body="));
  assert.match(bodyField, /cancelled/);
  assert.match(bodyField, /3 attempt/);
  assert.match(bodyField, /workflow_dispatch/);
  assert.doesNotMatch(bodyField, /Security update PRs/);
});

test("skips requeue if PR head SHA changed before cancellation completed", () => {
  const res = runResult({
    verifyResult: "success",
    evalResult: "cancelled",
    attempt: "1",
    pr: {
      head: {
        sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ref: "dependabot/npm_and_yarn/mcp-server-typescript-express/keycard-abc123",
      },
    },
  });
  assert.equal(res.status, 0);
  assert.equal(res.calls.length, 0);
});

test("treats mid-execution cancelled job (e.g. timeout) as failure instead of requeuing", () => {
  const res = runResult({
    verifyResult: "success",
    evalResult: "cancelled",
    attempt: "1",
    jobs: [
      {
        name: "eval / eval (mcp-server-typescript-express)",
        conclusion: "cancelled",
        steps: [{ name: "Run eval" }],
      },
    ],
  });
  assert.equal(res.status, 1);
  assert.equal(res.calls.find((c) => c.cmd === "workflow_run"), undefined);
  const statusCall = res.calls.find((c) => c.cmd === "api" && c.endpoint.includes("/statuses/"));
  assert.ok(statusCall);
  assert.ok(statusCall.fields.includes("state=failure"));
});

test("does not show security note on non-security PR even when body mentions security", () => {
  const res = runResult({
    verifyResult: "success",
    evalResult: "failure",
    jobs: [{ name: "eval / eval (mcp-server-typescript-express)", conclusion: "failure" }],
  });
  assert.equal(res.status, 1);
  const commentCall = res.calls.find((c) => c.cmd === "api" && c.endpoint.includes("/comments"));
  assert.ok(commentCall);
  const bodyField = commentCall.fields.find((f: string) => f.startsWith("body="));
  assert.doesNotMatch(bodyField, /Security update PRs/);
});

test("shows security note for security group branch or security label", () => {
  const byBranch = runResult({
    verifyResult: "success",
    evalResult: "failure",
    pr: {
      body: "plain body",
      labels: [{ name: "dependencies" }],
      head: {
        sha: SHA,
        ref: "dependabot/npm_and_yarn/mcp-server-typescript-express/security-abc123",
      },
    },
  });
  assert.equal(byBranch.status, 1);
  const branchBody = byBranch.calls
    .find((c) => c.cmd === "api" && c.endpoint.includes("/comments"))
    ?.fields.find((f: string) => f.startsWith("body="));
  assert.match(branchBody, /Security update PRs/);

  const byLabel = runResult({
    verifyResult: "success",
    evalResult: "failure",
    pr: {
      body: "plain body",
      labels: [{ name: "dependencies" }, { name: "security" }],
      head: {
        sha: SHA,
        ref: "dependabot/npm_and_yarn/mcp-server-typescript-express/foo-1.2.3",
      },
    },
  });
  assert.equal(byLabel.status, 1);
  const labelBody = byLabel.calls
    .find((c) => c.cmd === "api" && c.endpoint.includes("/comments"))
    ?.fields.find((f: string) => f.startsWith("body="));
  assert.match(labelBody, /Security update PRs/);
});
