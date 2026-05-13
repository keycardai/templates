# Contributing

Thanks for your interest in adding a template. This repo is intentionally minimal: a template is a directory at the root of the repo containing a runnable project plus two markdown files.

## Layout

```
<template-id>/
├── README.md      # how to run the template
├── SPEC.md        # Keycard resources the agent MUST provision
├── ...            # the actual project files (package.json, src/, pyproject.toml, …)
```

If a value would normally be a placeholder, just commit a sensible default and document the env var that overrides it (see `mcp-server-typescript-express` for the pattern).

## Naming convention

Template directories follow `<kind>-<language>-<framework>`:

- **kind** — `mcp-server`, `agent`, `worker`, …
- **language** — `typescript`, `python`, `go`, …
- **framework** — `express`, `hono`, `fastapi`, `chi`, …

Flat, predictable, collision-free across multiple kinds.

## What `README.md` must cover

1. One-line description.
2. The exact native commands to install, build, and run (e.g. `npm install && npm run start`).
3. Every env var the project reads, with default and purpose.
4. A pointer to `SPEC.md` for Keycard provisioning.

## What `SPEC.md` must cover

This is the contract with whatever agent provisions Keycard for the user. It MUST list:

1. Every Keycard **Resource** that must exist (id, kind, transport, endpoint).
2. The **minimum Cedar policy** required for the template's tools/endpoints to work, written as Cedar.
3. What the `[credentials]` block in `keycard.toml` should look like (usually: empty unless the template calls a third-party API).
4. Explicit **MUST NOTs** — things the agent should refuse to do (committing URLs, inventing resource ids, adding policy for non-existent tools, …).
5. A short **verification** checklist the agent can run after provisioning.

Keep `SPEC.md` short and unambiguous. It is read by agents, not humans browsing GitHub.

## `keycard.toml` format

Every template's `keycard.toml` uses the **minimal** format — only static IDs and credential-mapping entries:

```toml
[org]
id = "<org-id>"

[zone]
id = "<zone-id>"
```

Do **not** add `schema_version`, `[project]`, `[server]`, or a `[zone].url` field. Runtime config (`KEYCARD_URL`, `PORT`, etc.) belongs in `.env`. TOML does not expand environment variables — `${KEYCARD_URL}` would be treated as a literal string.

## Lockfiles

Commit `package-lock.json` (or the equivalent for other package managers). Someone copying a template directory should get the same dependency versions that were tested.

## Defaults over placeholders

Templates run as-is. Bake in defaults that work for `npm run dev`, then let the user override via env vars.

## Code of Conduct

Be kind. Reviews focus on correctness, scope, and maintainability — not style preferences. Templates that duplicate existing ones without a clear differentiator will be closed.
