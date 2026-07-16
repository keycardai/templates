# Templates for Keycard

A collection of starter projects for building Keycard-protected MCP servers, agents, and other AI workloads. Each template is a self-contained project at the root of this repo. Copy a directory, follow its `README.md`, and you have a working project.

You are encouraged to use, modify, and extend this code.

## How to use a template

```bash
git clone --depth=1 https://github.com/keycardai/templates
cp -R templates/<template-name> my-project
cd my-project
# follow the template's README.md from here
```

Each template runs with whatever the native toolchain expects (`npm install && npm run start` for Node, `uv sync && uv run` for Python, etc.). There is no Keycard-specific build step.

## How to provision Keycard for a template

Every template ships a `SPEC.md` describing the Keycard resources that **must** be provisioned for the project to work — the Application, Resource, credential provider, what the `[credentials]` block should look like, and what the agent must *not* do. Read it before running anything against a real Keycard environment.

Agents (the Keycard skills, or your own automation) MUST treat `SPEC.md` as the source of truth for provisioning. The template files themselves intentionally do not encode Keycard state.

## Available templates

| Template | Kind | Language | Framework |
|---|---|---|---|
| [`mcp-server-typescript-express`](./mcp-server-typescript-express) | MCP server | TypeScript | Express 5 |
| [`mcp-server-python-mcp`](./mcp-server-python-mcp) | MCP server | Python | FastMCP |
| [`mcp-brokered-credentials-typescript`](./mcp-brokered-credentials-typescript) | MCP proxy | TypeScript | Express 5 |
| [`mcp-brokered-credentials-python`](./mcp-brokered-credentials-python) | MCP proxy | Python | FastMCP |
| [`autonomous-agent-snowflake-wif`](./autonomous-agent-snowflake-wif) | Agent | TypeScript | — |
| [`databricks-agent`](./databricks-agent) | MCP server | Python | FastMCP |

**MCP server** — a Keycard-protected MCP server exposing tools to Claude.

**MCP proxy** — proxies an upstream OAuth-protected MCP server (Linear) using Keycard-brokered credentials. No API keys stored anywhere; credentials are minted per request via RFC 8693.

**Agent** — an autonomous agent with its own workload identity, not dependent on a user session.

## Contributing

We welcome new templates. See [CONTRIBUTING.md](./CONTRIBUTING.md) — the bar is intentionally low: a directory, a `README.md`, a `SPEC.md`, and code that runs.
