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
  metadata?: Record<string, unknown> | null;
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

function makeBotCommit(overrides: Record<string, unknown> = {}) {
  return {
    author: { login: "dependabot[bot]" },
    committer: { login: "web-flow" },
    commit: { verification: { verified: true } },
    ...overrides,
  };
}

function makeTempRepoRoot(skipContent = "") {
  const root = mkdtempSync(join(tmpdir(), "bump-gate-repo-"));
  mkdirSync(join(root, "mcp-server-go"), { recursive: true });
  writeFileSync(join(root, "mcp-server-go/go.mod"), "module example\n");
  mkdirSync(join(root, "mcp-server-java"), { recursive: true });
  writeFileSync(join(root, "mcp-server-java/build.gradle.kts"), "// gradle\n");
  for (const template of ["agent-python-langchain", "a2a-delegation-python"]) {
    mkdirSync(join(root, template));
    writeFileSync(join(root, template, "pyproject.toml"), "[project]\n");
  }
  mkdirSync(join(root, "eval"), { recursive: true });
  writeFileSync(join(root, "eval/eval-skip.txt"), skipContent);
  return root;
}

function runGate(opts: RunOptions = {}) {
  const eventName = opts.eventName ?? "workflow_run";
  const defaultFixtures: Record<string, unknown> = {
    [`repos/keycardai/templates/pulls?state=open&head=keycardai:${BRANCH}&per_page=10`]: [makePr()],
    "repos/keycardai/templates/pulls/42": makePr(),
    "repos/keycardai/templates/pulls/42/commits?per_page=100": [makeBotCommit()],
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
  const ownedRepoRoot = opts.repoRoot ? null : makeTempRepoRoot();
  try {
    const output = join(dir, "output");
    writeFileSync(output, "");
    let metadataFile = "";
    if (opts.metadata !== null) {
      metadataFile = join(dir, "dependabot-metadata.json");
      writeFileSync(
        metadataFile,
        JSON.stringify(
          opts.metadata ?? {
            head_sha: opts.runHeadSha ?? SHA,
            dependency_names: "github.com/keycardai/go-sdk",
            update_type: "version-update:semver-minor",
            dependency_group: "keycard",
            package_ecosystem: "gomod",
          },
        ),
      );
    }
    execFileSync("bash", ["-c", BASH_MOCK], {
      env: {
        ...process.env,
        FIXTURES: JSON.stringify(defaultFixtures),
        SCRIPT_PATH: SCRIPT,
        REPO_ROOT: opts.repoRoot ?? ownedRepoRoot!,
        METADATA_FILE: metadataFile,
        GITHUB_REPOSITORY: "keycardai/templates",
        GITHUB_OUTPUT: output,
        EVENT_NAME: eventName,
        INPUT_PR: opts.inputPr ?? "",
        WORKFLOW_RUN_ID: "999",
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
    if (ownedRepoRoot) {
      rmSync(ownedRepoRoot, { recursive: true, force: true });
    }
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

test("rejects non-dependabot PR author, non-main base, and fork head repo", () => {
  const badAuthor = runGate({
    fixtures: {
      [`repos/keycardai/templates/pulls?state=open&head=keycardai:${BRANCH}&per_page=10`]: [
        makePr({ user: { login: "some-human" } }),
      ],
    },
  });
  assert.equal(badAuthor.ok, "false");
  assert.equal(badAuthor.pr, "42");
  assert.match(badAuthor.reason, /PR author/);

  const badBase = runGate({
    fixtures: {
      [`repos/keycardai/templates/pulls?state=open&head=keycardai:${BRANCH}&per_page=10`]: [
        makePr({ base: { ref: "release" } }),
      ],
    },
  });
  assert.equal(badBase.ok, "false");
  assert.equal(badBase.pr, "42");
  assert.match(badBase.reason, /PR base branch/);

  const badHeadRepo = runGate({
    fixtures: {
      [`repos/keycardai/templates/pulls?state=open&head=keycardai:${BRANCH}&per_page=10`]: [
        makePr({ head: { sha: SHA, ref: BRANCH, repo: { full_name: "attacker/templates" } } }),
      ],
    },
  });
  assert.equal(badHeadRepo.ok, "false");
  assert.equal(badHeadRepo.pr, "42");
  assert.match(badHeadRepo.reason, /PR head repository/);
});

test("no-ops when Template CI run head SHA no longer matches PR head", () => {
  const stale = runGate({
    runHeadSha: "2222222222222222222222222222222222222222",
  });
  assert.equal(stale.ok, "false");
  assert.equal(stale.pr, "");
  assert.equal(stale.head_sha, "");
  assert.match(stale.reason, /no longer matches run head SHA/);
});

test("rejects PR when any commit was authored by a human, has no GitHub author, or is unverified", () => {
  const human = runGate({
    fixtures: {
      "repos/keycardai/templates/pulls/42/commits?per_page=100": [
        makeBotCommit(),
        makeBotCommit({ author: { login: "Larry-Osakwe" } }),
      ],
    },
  });
  assert.equal(human.ok, "false");
  assert.match(human.reason, /not authored by dependabot\[bot\]/);

  const nullAuthor = runGate({
    fixtures: {
      "repos/keycardai/templates/pulls/42/commits?per_page=100": [
        makeBotCommit(),
        makeBotCommit({ author: null }),
      ],
    },
  });
  assert.equal(nullAuthor.ok, "false");
  assert.match(nullAuthor.reason, /not authored by dependabot\[bot\] \(author: unknown\)/);

  const spoofedUnverified = runGate({
    fixtures: {
      "repos/keycardai/templates/pulls/42/commits?per_page=100": [
        makeBotCommit({ commit: { verification: { verified: false } } }),
      ],
    },
  });
  assert.equal(spoofedUnverified.ok, "false");
  assert.match(spoofedUnverified.reason, /unverified commit/);

  const spoofedCommitter = runGate({
    fixtures: {
      "repos/keycardai/templates/pulls/42/commits?per_page=100": [
        makeBotCommit({ committer: { login: "some-pusher" } }),
      ],
    },
  });
  assert.equal(spoofedCommitter.ok, "false");
  assert.match(spoofedCommitter.reason, /unverified commit/);
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

test("flags Gradle wrapper script and jar changes as needing human review", () => {
  for (const file of [
    "mcp-server-java/gradlew",
    "mcp-server-java/gradlew.bat",
    "mcp-server-java/gradle/wrapper/gradle-wrapper.jar",
  ]) {
    const out = runGate({
      fixtures: {
        "repos/keycardai/templates/pulls/42/files?per_page=100": [
          { filename: "mcp-server-java/gradle/wrapper/gradle-wrapper.properties" },
          { filename: file },
        ],
      },
    });
    assert.equal(out.ok, "false");
    assert.equal(out.pr, "42");
    assert.match(out.reason, /needs human review/);
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

test("rejects with red result when Template CI concludes failure", () => {
  const out = runGate({ runConclusion: "failure" });
  assert.equal(out.ok, "false");
  assert.equal(out.pr, "42");
  assert.match(out.reason, /Template CI concluded failure/);
  assert.match(out.reason, new RegExp(CI_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("no-ops when Template CI concludes cancelled, skipped, or stale", () => {
  for (const conclusion of ["cancelled", "skipped", "stale"]) {
    const out = runGate({ runConclusion: conclusion });
    assert.equal(out.ok, "false");
    assert.equal(out.pr, "");
    assert.equal(out.head_sha, "");
    assert.match(out.reason, new RegExp(`Ignoring ${conclusion} Template CI run`));
  }
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

test("automerge policy: Keycard major merges, third-party minor merges, third-party major does not", () => {
  const keycardMajor = runGate({
    metadata: {
      head_sha: SHA,
      dependency_names: "github.com/keycardai/go-sdk",
      update_type: "version-update:semver-major",
      dependency_group: "keycard",
      package_ecosystem: "gomod",
    },
  });
  assert.equal(keycardMajor.ok, "true");
  assert.equal(keycardMajor.automerge, "true");

  const thirdPartyMinor = runGate({
    metadata: {
      head_sha: SHA,
      dependency_names: "golang.org/x/net",
      update_type: "version-update:semver-minor",
      dependency_group: "third-party",
      package_ecosystem: "gomod",
    },
  });
  assert.equal(thirdPartyMinor.ok, "true");
  assert.equal(thirdPartyMinor.automerge, "true");

  const thirdPartyMajor = runGate({
    metadata: {
      head_sha: SHA,
      dependency_names: "golang.org/x/net",
      update_type: "version-update:semver-major",
      dependency_group: "",
      package_ecosystem: "gomod",
    },
  });
  assert.equal(thirdPartyMajor.ok, "true");
  assert.equal(thirdPartyMajor.automerge, "false");
  assert.match(thirdPartyMajor.automerge_reason, /major/i);

  const mixedMajor = runGate({
    metadata: {
      head_sha: SHA,
      dependency_names: "github.com/keycardai/go-sdk, golang.org/x/net",
      update_type: "version-update:semver-major",
      dependency_group: "keycard",
      package_ecosystem: "gomod",
    },
  });
  assert.equal(mixedMajor.ok, "true");
  assert.equal(mixedMajor.automerge, "false");
});

test("automerge policy: security major merges and missing or mismatched metadata does not merge", () => {
  const secBranch = "dependabot/gomod/mcp-server-go/security-123";
  const secPr = makePr({
    head: {
      sha: SHA,
      ref: secBranch,
      repo: { full_name: "keycardai/templates" },
    },
  });
  const secMajor = runGate({
    runHeadBranch: secBranch,
    metadata: null,
    fixtures: {
      [`repos/keycardai/templates/pulls?state=open&head=keycardai:${secBranch}&per_page=10`]: [secPr],
    },
  });
  assert.equal(secMajor.ok, "true");
  assert.equal(secMajor.automerge, "true");

  const missingMeta = runGate({
    metadata: null,
    fixtures: {
      "repos/keycardai/templates/actions/runs/999/artifacts?per_page=100": { artifacts: [] },
      [`repos/keycardai/templates/commits/${SHA}`]: {
        ...makeBotCommit(),
        commit: {
          verification: { verified: true },
          message: "chore(deps): bump without metadata block\n",
        },
      },
    },
  });
  assert.equal(missingMeta.ok, "true");
  assert.equal(missingMeta.automerge, "false");
  assert.match(missingMeta.automerge_reason, /missing/i);

  const wrongSha = runGate({
    metadata: {
      head_sha: "2222222222222222222222222222222222222222",
      dependency_names: "github.com/keycardai/go-sdk",
      update_type: "version-update:semver-minor",
      dependency_group: "keycard",
      package_ecosystem: "gomod",
    },
  });
  assert.equal(wrongSha.ok, "true");
  assert.equal(wrongSha.automerge, "false");
  assert.match(wrongSha.automerge_reason, /SHA mismatch/i);
});

test("automerge policy: commit-message YAML fallback handles minor, major, Keycard major, and missing block", () => {
  const minorFallback = runGate({
    metadata: null,
    fixtures: {
      "repos/keycardai/templates/actions/runs/999/artifacts?per_page=100": { artifacts: [] },
      [`repos/keycardai/templates/commits/${SHA}`]: {
        ...makeBotCommit(),
        commit: {
          verification: { verified: true },
          message: [
            "chore(deps): bump the third-party group",
            "",
            "---",
            "updated-dependencies:",
            "- dependency-name: golang.org/x/net",
            "  dependency-type: direct:production",
            "  update-type: version-update:semver-patch",
            "- dependency-name: golang.org/x/sys",
            "  dependency-type: direct:production",
            "  update-type: version-update:semver-minor",
            "...",
            "",
            "Signed-off-by: dependabot[bot] <support@github.com>",
          ].join("\n"),
        },
      },
    },
  });
  assert.equal(minorFallback.ok, "true");
  assert.equal(minorFallback.automerge, "true");

  const majorFallback = runGate({
    metadata: null,
    fixtures: {
      "repos/keycardai/templates/actions/runs/999/artifacts?per_page=100": { artifacts: [] },
      [`repos/keycardai/templates/commits/${SHA}`]: {
        ...makeBotCommit(),
        commit: {
          verification: { verified: true },
          message: [
            "chore(deps): bump group",
            "",
            "---",
            "updated-dependencies:",
            "- dependency-name: golang.org/x/net",
            "  dependency-type: direct:production",
            "  update-type: version-update:semver-minor",
            "- dependency-name: golang.org/x/oauth2",
            "  dependency-type: direct:production",
            "  update-type: version-update:semver-major",
            "---",
          ].join("\n"),
        },
      },
    },
  });
  assert.equal(majorFallback.ok, "true");
  assert.equal(majorFallback.automerge, "false");
  assert.match(majorFallback.automerge_reason, /major/i);

  const keycardMajorFallback = runGate({
    metadata: null,
    fixtures: {
      "repos/keycardai/templates/actions/runs/999/artifacts?per_page=100": { artifacts: [] },
      [`repos/keycardai/templates/commits/${SHA}`]: {
        ...makeBotCommit(),
        commit: {
          verification: { verified: true },
          message: [
            "chore(deps): bump keycard",
            "",
            "---",
            "updated-dependencies:",
            "- dependency-name: github.com/keycardai/go-sdk",
            "  dependency-type: direct:production",
            "  update-type: version-update:semver-major",
            "...",
          ].join("\n"),
        },
      },
    },
  });
  assert.equal(keycardMajorFallback.ok, "true");
  assert.equal(keycardMajorFallback.automerge, "true");
});

const pythonFloors = [
  [86, "agent-python-langchain", "pytest", "8.0", "9.2.0", "major"],
  [87, "agent-python-langchain", "python-dotenv", "1.0.0", "1.2.4", "minor"],
  [91, "a2a-delegation-python", "a2a-sdk[http-server]", "1.2.0", "1.3.1", "minor"],
  [94, "agent-python-langchain", "langchain-anthropic", "1.6", "1.7.13", "minor"],
  [99, "agent-python-langchain", "langchain", "1.0", "1.5.2", "minor"],
  [102, "agent-python-langchain", "langgraph-cli[inmem]", "0.4", "0.4.44", "patch"],
] as const;

function runPythonFloorGate(
  template: string,
  dependency: string,
  patch: string | null,
  message: string,
  options: {
    ecosystem?: "uv" | "pip";
    verified?: boolean;
    updateType?: string;
    artifact?: boolean;
    commitPatch?: string;
    commitCount?: number;
  } = {},
) {
  const ecosystem = options.ecosystem ?? "uv";
  const branch = `dependabot/${ecosystem}/${template}/requirement`;
  const pr = makePr({ head: { sha: SHA, ref: branch, repo: { full_name: "keycardai/templates" } } });
  const files = (manifestPatch: string | null) => [
    { filename: `${template}/pyproject.toml`, patch: manifestPatch },
    ...(template === "a2a-delegation-python" ? [{ filename: `${template}/uv.lock` }] : []),
  ];
  return runGate({
    runHeadBranch: branch,
    metadata: options.artifact === false ? null : {
      head_sha: SHA,
      dependency_names: dependency,
      update_type: options.updateType ?? "",
      package_ecosystem: ecosystem,
    },
    fixtures: {
      [`repos/keycardai/templates/pulls?state=open&head=keycardai:${branch}&per_page=10`]: [pr],
      "repos/keycardai/templates/pulls/42/commits?per_page=100": Array.from(
        { length: options.commitCount ?? 1 }, () => makeBotCommit(),
      ),
      "repos/keycardai/templates/pulls/42/files?per_page=100": files(patch),
      "repos/keycardai/templates/actions/runs/999/artifacts?per_page=100": { artifacts: [] },
      [`repos/keycardai/templates/commits/${SHA}`]: makeBotCommit({
        commit: { verification: { verified: options.verified ?? true }, message },
        files: files(options.commitPatch ?? null),
      }),
    },
  });
}

function floorPatch(dependency: string, oldFloor: string, newFloor: string) {
  return `-    "${dependency}>=${oldFloor}",\n+    "${dependency}>=${newFloor}",`;
}

function floorMessage(dependency: string, version: string) {
  return [
    "",
    "---",
    "updated-dependencies:",
    `- dependency-name: ${dependency}`,
    `  dependency-version: ${version}`,
    `  dependency-type: direct:${dependency === "pytest" ? "development" : "production"}`,
    "...",
    "",
    "Signed-off-by: dependabot[bot] <support@github.com>",
  ].join("\n");
}

for (const [pr, template, dependency, oldFloor, newFloor, type] of pythonFloors) {
  const expected = type === "major" ? "false" : "true";
  const reason = type === "major" ? "Third-party semver-major update needs human review" : "";

  test(`PR #${pr}: infer ${type} for ${dependency} from the manifest diff`, () => {
    const out = runPythonFloorGate(template, dependency, floorPatch(dependency, oldFloor, newFloor), "");
    assert.equal(out.ok, "true");
    assert.equal(out.automerge, expected);
    assert.equal(out.automerge_reason, reason);
  });

  test(`PR #${pr}: infer ${type} for ${dependency} from the verified commit diff`, () => {
    const out = runPythonFloorGate(template, dependency, null, floorMessage(dependency, newFloor), {
      artifact: false,
      commitPatch: floorPatch(dependency, oldFloor, newFloor),
    });
    assert.equal(out.ok, "true");
    assert.equal(out.automerge, expected);
    assert.equal(out.automerge_reason, reason);
  });
}

test("Python floor inference keeps explicit and unparseable updates under review", () => {
  const template = "agent-python-langchain";
  const dependency = "langgraph-cli[inmem]";
  const message = floorMessage(dependency, "0.4.44");

  const preOneMajor = runPythonFloorGate(template, dependency, floorPatch(dependency, "0.4", "0.5"), message, { ecosystem: "pip" });
  assert.equal(preOneMajor.automerge_reason, "Third-party semver-major update needs human review");

  const explicitMajor = runPythonFloorGate(template, dependency, floorPatch(dependency, "0.4", "0.4.44"), message, {
    updateType: "version-update:semver-major",
  });
  assert.equal(explicitMajor.automerge_reason, "Third-party semver-major update needs human review");

  const unparseable = runPythonFloorGate(template, dependency, floorPatch(dependency, "0.4", "0.4.44rc1"), message);
  const unverified = runPythonFloorGate(template, dependency, null, message, {
    verified: false,
    commitPatch: floorPatch(dependency, "0.4", "0.4.44"),
  });
  for (const out of [unparseable, unverified]) {
    assert.equal(out.ok, "true");
    assert.equal(out.automerge, "false");
    assert.match(out.automerge_reason, /treating as major/);
  }
});

test("Python floor inference does not mistake a locked version for the old floor", () => {
  const template = "agent-python-langchain";
  const dependency = "pytest";
  const message = [
    "Updates the requirements on [pytest](https://github.com/pytest-dev/pytest) to permit the latest version.",
    "- [Commits](https://github.com/pytest-dev/pytest/compare/9.0.0...9.2.0)",
    floorMessage(dependency, "9.2.0"),
  ].join("\n");
  const major = runPythonFloorGate(template, dependency, null, message, {
    commitPatch: floorPatch(dependency, "8.0", "9.2.0"),
  });
  assert.equal(major.ok, "true");
  assert.equal(major.automerge, "false");
  assert.equal(major.automerge_reason, "Third-party semver-major update needs human review");

  const missing = runPythonFloorGate(template, dependency, null, message);
  const multiCommit = runPythonFloorGate(template, dependency, null, message, {
    commitPatch: floorPatch(dependency, "9.0", "9.2.0"),
    commitCount: 2,
  });
  for (const out of [missing, multiCommit]) {
    assert.equal(out.ok, "true");
    assert.equal(out.automerge, "false");
    assert.match(out.automerge_reason, /treating as major/);
  }
});
