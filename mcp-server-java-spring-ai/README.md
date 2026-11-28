# mcp-server-java-spring-ai

A Spring AI WebMVC MCP server with a `hello` tool. The Keycard Spring Boot starter verifies the caller's token with Spring Security and serves OAuth discovery metadata for the Streamable HTTP endpoint.

## Run locally

Use JDK 17 or newer, `curl`, and `jq`. Follow [SPEC.md](./SPEC.md) to provision Keycard.

```bash
cp .env.example .env
# Edit .env for your Keycard zone and Resource.
set -a
source .env
set +a
./gradlew installDist
./build/install/mcp-server-java-spring-ai/bin/mcp-server-java-spring-ai
```

Connect a Keycard-authorized MCP client to `http://localhost:8000/mcp`. Call `hello` with `{"name":"Ada"}` and expect `Hello, Ada!`. Add tools as Spring beans following the `tools()` example in `src/main/java/example/Application.java`.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `KEYCARD_URL` | Required | Zone OIDC issuer URL. |
| `KEYCARD_RESOURCE_ID` | `http://localhost:<PORT>/mcp` | Registered MCP Resource URL and token audience. |
| `PORT` | `8000` | HTTP listen port. |
