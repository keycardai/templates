# mcp-server-java

A minimal MCP server, integrated with Keycard identity, authentication and authorization, using [`ai.keycard:keycard-mcp`](https://central.sonatype.com/artifact/ai.keycard/keycard-mcp), the official [MCP Java SDK](https://github.com/modelcontextprotocol/java-sdk) (Streamable HTTP servlet transport), and embedded Jetty.

This template is a plain Gradle application. There is no scaffolding step: copy the directory, set `KEYCARD_URL`, and run.

## Run it

```bash
cp -R mcp-server-java my-mcp-server
cd my-mcp-server
./gradlew installDist
export KEYCARD_URL=https://your-zone.keycard.cloud
./build/install/mcp-server-java/bin/mcp-server-java
```

The server listens on `http://localhost:8000/mcp` and validates Keycard-minted JWTs against `KEYCARD_URL`. `./gradlew run` works too, but keeps Gradle in the foreground.

The Gradle wrapper is checked in, so the only prerequisite is a JDK 17 or newer.

## Configure

| Env var | Default | Purpose |
|---|---|---|
| `KEYCARD_URL` | _(required)_ | The zone's OIDC issuer URL. The verifier trusts tokens from it and resolves its JWKS. |
| `KEYCARD_RESOURCE_ID` | `http://localhost:<PORT>/mcp` | The registered Resource identifier. Drives the protected-resource metadata document, the 401 `resource_metadata` challenge URL and the verifier audience. |
| `PORT` | `8000` | Local HTTP port. |

Keycard configuration is read in `Server.java` and passed to the SDK explicitly. The SDK reads no environment variables of its own.

## Keycard provisioning

Before the server can accept requests, the zone needs an Application and a Resource for the `/mcp` endpoint, backed by the zone's `keycard-sts` provider. See [`SPEC.md`](./SPEC.md) for the exact primitives an agent should provision.

## Add a tool

Register another tool with `.toolCall(tool, handler)` on the `McpServer.sync(...)` builder in `src/main/java/example/Server.java`, following the `hello` pattern. Tools are gated by the `mcp:tools` scope the bearer filter enforces.

## Java version

Requires Java 17 or newer, matching `keycard-mcp`. The build compiles with `--release 17` on whatever JDK runs Gradle.
