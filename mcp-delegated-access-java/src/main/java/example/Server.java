package example;

import ai.keycard.mcp.AuthProvider;
import ai.keycard.mcp.KeycardRequest;
import ai.keycard.mcp.RequireBearerAuthFilter;
import ai.keycard.oauth.AccessContext;
import ai.keycard.oauth.ClientSecret;
import ai.keycard.oauth.KeycardException;
import ai.keycard.oauth.OAuthErrorException;
import ai.keycard.oauth.TokenResponse;
import com.nimbusds.jose.util.JSONObjectUtils;
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

/** An MCP server and delegated-access broker behind Keycard bearer authentication. */
public final class Server {

    static final String NAME = "mcp-delegated-access-java";
    static final String MCP_PATH = "/mcp";
    static final String BROKER_PATH = "/broker";
    static final String SCOPE = "mcp:tools";

    private Server() {}

    public static void main(String[] args) throws Exception {
        System.setProperty("org.slf4j.simpleLogger.defaultLogLevel", "warn");

        URI zone = URI.create(requiredEnv("KEYCARD_URL"));
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8000"));
        // The registered Resource identifier, e.g. http://localhost:8000/mcp. One identifier
        // drives the protected-resource document, the 401 challenge URL and the verifier audience.
        String resourceId = System.getenv("KEYCARD_RESOURCE_ID");
        if (resourceId == null || resourceId.isBlank()) {
            resourceId = "http://localhost:" + port + MCP_PATH;
        }

        // 1. Build the MCP server and register tools on the MCP Java SDK.
        HttpServletStreamableServerTransportProvider transport =
                HttpServletStreamableServerTransportProvider.builder().mcpEndpoint(MCP_PATH).build();
        McpSyncServer mcp = McpServer.sync(transport)
                .serverInfo(NAME, "1.0.0")
                .capabilities(ServerCapabilities.builder().tools(false).build())
                .toolCall(helloTool(), (exchange, request) -> hello(request))
                .build();

        // 2. Bind the zone and resource identifier once so token verification, protected-resource
        // metadata and 401 challenges share the same policy. The grant uses the app credential.
        AuthProvider auth = AuthProvider.builder(zone)
                .resourceIdentifier(resourceId)
                .credential(ClientSecret.of(requiredEnv("KEYCARD_CLIENT_ID"), requiredEnv("KEYCARD_CLIENT_SECRET")))
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
        context.addFilter(bearer, BROKER_PATH, EnumSet.of(DispatcherType.REQUEST));
        ServletHolder mcpHolder = new ServletHolder(transport);
        mcpHolder.setAsyncSupported(true);
        context.addServlet(mcpHolder, MCP_PATH);

        // 3c. After bearer auth, exchange for the same resource, as the Go broker does.
        context.addFilter(new FilterHolder(auth.grant(resourceId)), BROKER_PATH, EnumSet.of(DispatcherType.REQUEST));
        context.addServlet(new ServletHolder(new Broker(resourceId)), BROKER_PATH);

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

    private static String requiredEnv(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " environment variable is required");
        }
        return value;
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

    /** Reports the outcome of the grant and keeps the exchanged token on the server. */
    static final class Broker extends HttpServlet {

        private static final long serialVersionUID = 1L;
        private final String resourceId;

        Broker(String resourceId) {
            this.resourceId = resourceId;
        }

        @Override
        protected void doGet(HttpServletRequest request, HttpServletResponse response) throws IOException {
            AccessContext access = KeycardRequest.accessContext(request).orElseThrow();
            KeycardException failure = access.resourceError(resourceId).or(access::error).orElse(null);
            Map<String, Object> result;
            if (failure == null) {
                TokenResponse token = access.access(resourceId);
                result = Map.of(
                        "status", "success",
                        "brokered", true,
                        "resource", resourceId,
                        "token_type", token.tokenType(),
                        "expires_in", token.expiresIn() == null ? 0 : token.expiresIn().getSeconds());
            } else {
                // Report machine-readable OAuth codes without reflecting provider error text.
                OAuthErrorException oauth = failure instanceof OAuthErrorException error ? error : null;
                String code = oauth != null && oauth.error().matches("[a-z][a-z_]{0,63}") ? oauth.error() : "";
                result = Map.of(
                        "status", "partial_error",
                        "brokered", false,
                        "error", "Token exchange failed for " + resourceId,
                        "error_code", code,
                        "error_description", oauth == null ? "" : "The authorization server rejected the exchange.",
                        "raw_error", oauth == null ? failure.getClass().getSimpleName() : "");
            }
            response.setContentType("application/json");
            response.getWriter().write(JSONObjectUtils.toJSONString(result));
        }
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
