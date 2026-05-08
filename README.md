# Templates for Keycard

A collection of starter projects for building Keycard-protected MCP servers, agents, and other AI workloads. Each template is a self-contained project at the root of this repo. Copy a directory, follow its `README.md`, and you have a working project.

You are encouraged to use, modify, and extend this code.

## How to use a template

```bash
git clone --depth=1 https://github.com/keycardai/templates
cp -R templates/mcp-server-typescript-express my-mcp-server
cd my-mcp-server
# follow the template's README.md from here
```

Each template runs with whatever the native toolchain expects (`npm install && npm run start` for Node, `uv sync && uv run` for Python, `go run .` for Go, etc.). There is no Keycard-specific build step.

## How to provision Keycard for a template

Every template ships a [`SPEC.md`](./mcp-server-typescript-express/SPEC.md) describing the Keycard resources that **must** be provisioned for the project to work the Resource entry, the minimum Cedar policy, what the `[credentials]` block should look like, and what the agent must *not* do. Read it before running anything against a real keycard environment.

Agents (the Keycard skills, or your own automation) MUST treat `SPEC.md` as the source of truth for provisioning. The template files themselves intentionally do not encode keycard state.

## Available templates

| Template | Kind | Language | Framework |
|---|---|---|---|
| [`mcp-server-typescript-express`](./mcp-server-typescript-express) | mcp-server | TypeScript | Express 5 |

## Contributing

We welcome new templates. See [CONTRIBUTING.md](./CONTRIBUTING.md) — the bar is intentionally low: a directory, a `README.md`, a `SPEC.md`, and code that runs.
