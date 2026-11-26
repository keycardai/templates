package example;

import ai.keycard.mcp.AuthProvider;
import ai.keycard.mcp.RequireBearerAuthFilter;
import io.modelcontextprotocol.server.McpServer;
import io.modelcontextprotocol.server.McpSyncServer;
import io.modelcontextprotocol.server.transport.HttpServletStreamableServerTransportProvider;
import io.modelcontextprotocol.spec.McpSchema.CallToolRequest;
import io.modelcontextprotocol.spec.McpSchema.CallToolResult;
import io.modelcontextprotocol.spec.McpSchema.ServerCapabilities;
import io.modelcontextprotocol.spec.McpSchema.Tool;
import jakarta.servlet.DispatcherType;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import org.eclipse.jetty.ee10.servlet.FilterHolder;
import org.eclipse.jetty.ee10.servlet.ServletContextHandler;
import org.eclipse.jetty.ee10.servlet.ServletHolder;

/**
 * A minimal Keycard-protected MCP server: embedded Jetty plus the official MCP Java SDK for the
 * MCP transport, with Keycard providing the OAuth metadata endpoints and bearer-token filter via
 * keycard-mcp.
 *
 * <p>It exposes one tool, "hello". The point is the protocol plumbing around it: the .well-known
 * OAuth metadata, the bearer filter that validates Keycard-minted JWTs, and a scope-gated /mcp
 * endpoint. Configure KEYCARD_URL (the zone's OIDC issuer) and run.
 *
 * <p>Configuration is read here, in application code, and passed to the SDK explicitly. The SDK
 * itself reads no environment variables.
 */
public final class Server {

    static final String NAME = "mcp-server-java";
    static final String MCP_PATH = "/mcp";
    static final String SCOPE = "mcp:tools";

    private Server() {}

    public static void main(String[] args) throws Exception {
        System.setProperty("org.slf4j.simpleLogger.defaultLogLevel", "warn");

        String keycardUrl = System.getenv("KEYCARD_URL");
        if (keycardUrl == null || keycardUrl.isBlank()) {
            System.err.println("KEYCARD_URL environment variable is required (the zone's OIDC issuer URL)");
            System.exit(1);
        }
        URI zone = URI.create(keycardUrl);
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8000"));
        // The registered Resource identifier, e.g. http://localhost:8000/mcp. One identifier
        // drives the protected-resource document, the 401 challenge URL and the verifier audience.
        String resourceId = System.getenv("KEYCARD_RESOURCE_ID");
        if (resourceId == null || resourceId.isBlank()) {
            resourceId = "http://localhost:" + port + MCP_PATH;
        }

        // 1. Build the MCP server and register tools. This is the official SDK only; Keycard is
        // not involved here. Add your own tools alongside hello.
        HttpServletStreamableServerTransportProvider transport =
                HttpServletStreamableServerTransportProvider.builder().mcpEndpoint(MCP_PATH).build();
        McpSyncServer mcp = McpServer.sync(transport)
                .serverInfo(NAME, "1.0.0")
                .capabilities(ServerCapabilities.builder().tools(false).build())
                .toolCall(helloTool(), (exchange, request) -> hello(request))
                .build();

        // 2. Bind the zone and resource identifier once so token verification, protected-resource
        // metadata and 401 challenges share the same policy.
        AuthProvider auth = AuthProvider.builder(zone)
                .resourceIdentifier(resourceId)
                .build();

        ServletContextHandler context = new ServletContextHandler();

        // 3a. OAuth metadata so MCP clients can discover how to authenticate.
        context.addServlet(
                new ServletHolder(auth.protectedResourceMetadata()
                        .resourceName(NAME)
                        .scopesSupported(SCOPE)
                        .build()),
                "/.well-known/oauth-protected-resource/*");
        context.addServlet(
                new ServletHolder(auth.authorizationServerMetadata()),
                "/.well-known/oauth-authorization-server");

        // 3b. Protect /mcp with bearer auth scoped to mcp:tools. An unauthenticated request gets a
        // 401 with an RFC 6750 challenge advertising resource_metadata, which is how a client
        // discovers where to authenticate. The transport answers on an async context, so the
        // filter and the servlet are both async-supported.
        FilterHolder bearer = new FilterHolder(RequireBearerAuthFilter.builder(auth)
                .requiredScopes(SCOPE)
                .build());
        bearer.setAsyncSupported(true);
        context.addFilter(bearer, MCP_PATH + "/*", EnumSet.of(DispatcherType.REQUEST));
        ServletHolder mcpHolder = new ServletHolder(transport);
        mcpHolder.setAsyncSupported(true);
        context.addServlet(mcpHolder, MCP_PATH);

        // 3c. Unauthenticated liveness probe used by the smoke test.
        context.addServlet(new ServletHolder(new Health()), "/healthz");

        org.eclipse.jetty.server.Server jetty = new org.eclipse.jetty.server.Server(new InetSocketAddress("0.0.0.0", port));
        jetty.setHandler(context);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            mcp.closeGracefully();
            try {
                jetty.stop();
            } catch (Exception e) {
                // Exiting anyway.
            }
        }));
        jetty.start();
        System.out.println(NAME + " listening on http://localhost:" + port + MCP_PATH);
        jetty.join();
    }

    private static Tool helloTool() {
        Map<String, Object> schema = Map.of(
                "type", "object",
                "properties", Map.of("name", Map.of("type", "string", "description", "the name to greet")),
                "required", List.of());
        return Tool.builder("hello", schema).description("Say hello to a name.").build();
    }

    private static CallToolResult hello(CallToolRequest request) {
        Object name = request.arguments() == null ? null : request.arguments().get("name");
        String greeting = "Hello, " + (name instanceof String s && !s.isBlank() ? s : "world") + "!";
        return CallToolResult.builder().addTextContent(greeting).isError(false).build();
    }

    /** {@code GET /healthz}. */
    static final class Health extends HttpServlet {

        private static final long serialVersionUID = 1L;

        @Override
        protected void doGet(HttpServletRequest request, HttpServletResponse response) throws IOException {
            response.setContentType("application/json");
            response.getWriter().write("{\"status\":\"ok\"}");
        }
    }
}
