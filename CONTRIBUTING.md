# Contributing

Each template is a runnable project in its own directory at the repo root.
Before adding one, check the [template catalog](./README.md#available-templates)
and pick the closest example for your language and Keycard flow.

## Start a template

From the repo root, copy the starter and use your new template's name:

```sh
cp -R _skeleton mcp-server-typescript-example
```

Use `<kind>-<language>-<framework>` where applicable, for example
`mcp-server-typescript-express`. If the framework does not distinguish the
template, use a shorter descriptive name such as `mcp-server-go`. Names
starting with `_` are reserved for non-templates. Replace the starter's
placeholders, add the code and language manifest, and ignore local `.env`
and build artifacts. Update the root README catalog and add a
[CODEOWNERS](./.github/CODEOWNERS) entry for the directory below the fallback.
Use `@keycardai/engineering` until the actual owner is known.

## Required files

- **`README.md`**: Give a one-line description, prerequisites, exact native
  install, build, and run commands, and an example request or tool call.
  Document every environment variable the code reads, including its purpose,
  whether it is required, and its default. Link to `SPEC.md` for provisioning.
- **`SPEC.md`**: This is the provisioning and verification contract. The eval
  build agent follows it literally when checking config and building the
  project, so keep paths, commands, environment variables, and expected
  results in sync with the code. Specify the Application, credential provider,
  and each required Resource (identifier or how to derive it, kind, transport,
  endpoint, and dependencies as applicable). Include the minimum Cedar policy
  as code if one is required, or say no custom policy is needed. Give the exact
  `.env` and `keycard.toml` values or their sources, a runnable smoke test
  with expected results, and explicit actions the agent must not take, such
  as inventing resource IDs or committing secrets.
- **`.env.example`**: Include the variables users need to configure with
  safe examples or empty secret values. Prefer working defaults for values
  like the port and document how to override them. Use placeholders only for
  values that depend on real provisioning or user credentials. Never commit a
  populated `.env`.
- **`keycard.toml`**: Use the strict Keycard CLI format shown below. Keep real
  credentials out of the file; `[credentials]` is for mappings only and may
  be empty. Put runtime config such as `KEYCARD_URL` and `PORT` in the
  environment, not TOML. Do not add `schema_version`, `[project]`, `[server]`,
  a URL under `[zone]`, or harness metadata. TOML does not expand environment
  variables.
- **`scripts/ci-verify.sh`**: Replace the failing starter stub with the
  live checks described below.
- **Language manifest and dependency files**: Add the manifest shown below.
  Commit the standard lockfile or dependency checksum file where the toolchain
  uses one, so someone copying the template gets the tested dependencies.
  Follow the repo's language conventions: the Ruby CI setup resolves gems
  without a committed `Gemfile.lock`, and Java ships the Gradle wrapper.
- **Eval hints, only where needed**: Keep exceptions in the [eval harness](#eval-hints),
  keyed by directory name, rather than putting them in template configuration.

```toml
[org]
id = "<org-id>"

[zone]
id = "<zone-id>"

[credentials]
```

## Template CI

The `discover` job in [Template CI](./.github/workflows/ci.yml) scans root
directories for manifests and builds the matrix for each `verify-<language>`
job. Automatic discovery ignores hidden directories, names starting with
`_`, `scripts`, and `eval`. It excludes directories with `package.json`
from the Python matrix. Use one language manifest per template so automatic
discovery and named dispatch agree.

| Job | Manifest | Install or build step | Verification entry point |
|---|---|---|---|
| `verify-typescript` | `package.json` | Node 20: `npm install`, `npm run build` | `npm run ci:verify`, wired to `scripts/ci-verify.sh` in `package.json` |
| `verify-python` | `pyproject.toml` | Python 3.12: `uv sync` | `bash scripts/ci-verify.sh` |
| `verify-go` | `go.mod` | Go 1.25: `go build ./...` | `bash scripts/ci-verify.sh` |
| `verify-ruby` | `Gemfile` | Ruby 3.4: Bundler via `ruby/setup-ruby` | `bash scripts/ci-verify.sh` |
| `verify-java` | `build.gradle.kts` | Temurin 21: `./gradlew build installDist` | `bash scripts/ci-verify.sh` |

For a normal PR, the job creates an ephemeral Keycard zone, passes
`KEYCARD_URL`, `KEYCARD_CLIENT_ID`, `KEYCARD_CLIENT_SECRET`, and `PORT`
to the script in the template directory, then deletes the zone. CI owns
the zone and its configuration. The script should:

1. Start the app using the CI-provided environment. Trap exit to stop any
   processes it starts and bound the wait for readiness.
2. Verify the Keycard behavior the template demonstrates. For an inbound MCP
   server, check health, the expected OAuth protected-resource and
   authorization-server metadata, and that a request with no token returns
   `401` with the expected `WWW-Authenticate` challenge. Use
   [Java's script](./mcp-server-java/scripts/ci-verify.sh) as an example.
   For another kind of template, check its own behavior, such as graph
   registration for a LangGraph agent or agent cards and auth for A2A.
3. Exit nonzero on any failed assertion and do not print credentials.
   The full authenticated user flow is also checked by eval where applicable.

Confirm the PR's discover job picked up the template and the corresponding
verify job is green. To run just that template on a pushed branch:

```sh
gh workflow run "Template CI" --ref <branch> -f template=<name>
```

## Template Eval

Eval coverage is required before merge. Check that no Template Eval run is
queued or in progress, then dispatch a named run on the PR branch:

```sh
gh run list --workflow "Template Eval" --limit 10
gh workflow run "Template Eval" --ref <branch> -f template=<name>
```

Never run two evals against the shared eval zone at once, including scheduled
runs and anyone running locally against that zone. Jobs can collide on
resource identifiers, and stale-provisioning cleanup can delete an
application or resource another run is using. The matrix is serial within a
workflow run, not across workflow runs.

Open the named template's **Run eval** step. A passing run shows
`=== Results ===` with every check marked `✓`, ends with `✓ PASS`,
and exits successfully. For MCP servers this means the harness provisioned
Keycard, the agent built the template from its SPEC and provisioned config,
browser OAuth completed, and the server passed its health, metadata, and
authenticated and unauthenticated request checks. Agent and A2A templates
run their own flow-specific checks. A successful build, a skipped job, or
CI alone is not a passing eval. Link the passing run in the PR.

### Eval hints

The harness routes by template shape: `langgraph.json` selects the
outbound LangGraph agent flow; an A2A SDK dependency in the manifest
selects the A2A flow; otherwise it uses the inbound MCP server flow.
Start with an existing flow and use the narrowest hint if needed:

| Hint | When to use it |
|---|---|
| `AGENT_NOTES` in [`eval/index.ts`](./eval/index.ts) | Tell the MCP build agent about deliberate differences between harness provisioning and the real setup in `SPEC.md`. These notes override the SPEC where they conflict. For example, a provisioned credential may only be injected at server startup, so the build agent should build but skip that smoke test. Do not use notes to mask a stale or incorrect SPEC. |
| `SERVER_OVERRIDES` in [`eval/index.ts`](./eval/index.ts) | Set just the MCP startup `command` (executable and argument list), `port`, or `healthPath` if the language default, port `8000`, or `/healthz` does not fit. The harness uses the selected port and path for readiness, and the port for provisioning and cleanup. The final MCP verification still checks `/healthz`. |
| [`eval/eval-skip.txt`](./eval/eval-skip.txt) | Omit a template from the automatic matrix only if the harness has no compatible flow yet. Add one directory name per line and a `#` comment explaining why. A named dispatch bypasses this list. A skip is not coverage: get a compatible eval flow and a passing run before merging a new template. |

See the [eval README](./eval/README.md) for local setup and runtime details.

## Add a language: Java as the example

1. In [`ci.yml`](./.github/workflows/ci.yml), extend `discover` to expose
   the new language's output and emit the correct JSON for both the full
   matrix and named dispatch. Add `verify-<language>` to install its
   toolchain, build, run its verification script with the usual ephemeral
   zone environment, and clean up. Java uses `build.gradle.kts`,
   `verify-java`, Temurin 21, and `./gradlew build installDist`.
2. In [`eval.yml`](./.github/workflows/eval.yml), include the same manifest
   in automatic discovery and install the toolchain for its eval jobs.
   Java gates Temurin 21 and Gradle setup on `build.gradle.kts` and warms
   the wrapper and runtime dependencies before the build agent, whose shell
   calls time out after 60 seconds.
3. In [`eval/index.ts`](./eval/index.ts), detect the manifest and add a
   `SERVER_DEFAULTS` entry. Update the corresponding language and build
   instructions in [`eval/agent.ts`](./eval/agent.ts). Java builds with
   `./gradlew -q installDist` and starts
   `./build/install/<template>/bin/<template>`, where the Gradle project
   name matches the directory name. The harness passes `PORT` and Keycard
   config in the process environment. Verify the first template in both
   workflows.

## Review and merge

Open a PR ready for review. Describe what the template demonstrates and
include the CI and eval evidence. Address every finding from Claude Code
Review, Devin Review, and Socket. Get approval from the owner listed in
[CODEOWNERS](./.github/CODEOWNERS), then squash merge once checks and review
are complete. Keep review feedback focused on correctness, scope, and
maintainability. A new template should demonstrate something the existing
catalog does not.

Use no em dashes or en dashes in code, comments, commit messages, docs, or
PR text.
