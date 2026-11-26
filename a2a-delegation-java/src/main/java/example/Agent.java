package example;

import ai.keycard.a2a.A2aProtocol;
import ai.keycard.a2a.DelegationClient;
import ai.keycard.a2a.DelegationResult;
import ai.keycard.mcp.AuthorizationServerMetadataServlet;
import ai.keycard.mcp.KeycardRequest;
import ai.keycard.mcp.ProtectedResourceMetadataServlet;
import ai.keycard.mcp.RequireBearerAuthFilter;
import ai.keycard.oauth.AccessToken;
import ai.keycard.oauth.ClientSecret;
import ai.keycard.oauth.KeycardException;
import ai.keycard.oauth.TokenVerifier;
import com.nimbusds.jose.util.JSONObjectUtils;
import jakarta.servlet.DispatcherType;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.eclipse.jetty.ee10.servlet.FilterHolder;
import org.eclipse.jetty.ee10.servlet.ServletContextHandler;
import org.eclipse.jetty.ee10.servlet.ServletHolder;
import org.eclipse.jetty.server.Server;

/**
 * Two Keycard-protected A2A agents in one program, picked by the first argument.
 *
 * <ul>
 *   <li>{@code target} serves on {@code TARGET_BASE_URL} and answers each message with the claims
 *       of the token it verified: {@code sub}, {@code act} and {@code aud}.
 *   <li>{@code caller} serves on {@code CALLER_BASE_URL}. It takes a user's token, exchanges it for
 *       one scoped to the target with keycard-a2a's {@link DelegationClient} (RFC 8693, resource =
 *       the target, authenticated with the caller's own credential), sends the message, and returns
 *       the target's answer.
 * </ul>
 *
 * <p>Each agent's {@code /a2a/jsonrpc} sits behind keycard-mcp's bearer filter with the verifier's
 * audience bound to the agent's own base URL, so a token for any other resource gets a 401 with an
 * RFC 6750 challenge. Configuration is read here, in application code, and passed to the SDK
 * explicitly. The SDK itself reads no environment variables.
 */
public final class Agent {

    private Agent() {}

    public static void main(String[] args) throws Exception {
        System.setProperty("org.slf4j.simpleLogger.defaultLogLevel", "warn");
        String role = args.length == 1 ? args[0] : "";
        if (!role.equals("caller") && !role.equals("target")) {
            System.err.println("usage: a2a-delegation-java caller|target");
            System.exit(2);
        }

        URI zone = URI.create(requireEnv("KEYCARD_URL"));
        URI callerUrl = baseUrl("CALLER_BASE_URL", "http://localhost:9100");
        URI targetUrl = baseUrl("TARGET_BASE_URL", "http://localhost:9101");

        if (role.equals("caller")) {
            DelegationClient delegation = DelegationClient.builder(zone)
                    .credential(ClientSecret.of(requireEnv("KEYCARD_CLIENT_ID"), requireEnv("KEYCARD_CLIENT_SECRET")))
                    .build();
            serve(zone, callerUrl, "a2a-delegation-java caller", "delegate", (token, text) -> {
                // Discover the target's card, exchange the user's token for one scoped to the
                // target, and send the message. The user's own token never leaves this agent.
                DelegationResult result = delegation.invoke(targetUrl, token.token(), A2aProtocol.textMessage(text));
                return "target answered: " + result.text().orElse("(no text)");
            });
            return;
        }
        serve(zone, targetUrl, "a2a-delegation-java target", "whoami", (token, text) -> {
            // The filter has checked the signature, issuer, audience and expiry; these are the
            // claims of that verified token, not anything the caller asserted.
            Map<String, Object> report = new LinkedHashMap<>();
            report.put("sub", token.subject());
            report.put("act", token.claims().get("act"));
            report.put("aud", token.audiences());
            report.put("client_id", token.clientId());
            return "verified " + JSONObjectUtils.toJSONString(report);
        });
    }

    /** What an agent does with one message: the verified caller's token and the message text. */
    @FunctionalInterface
    interface Handler {
        String handle(AccessToken token, String text) throws KeycardException;
    }

    static void serve(URI zone, URI self, String name, String capability, Handler handler) throws Exception {
        String base = self.toString();
        ServletContextHandler context = new ServletContextHandler();

        // OAuth metadata so clients can discover which zone protects this agent.
        context.addServlet(
                new ServletHolder(ProtectedResourceMetadataServlet.builder(zone)
                        .resourceIdentifier(base)
                        .resourceName(name)
                        .build()),
                "/.well-known/oauth-protected-resource/*");
        context.addServlet(
                new ServletHolder(AuthorizationServerMetadataServlet.of(zone)),
                "/.well-known/oauth-authorization-server");

        context.addServlet(new ServletHolder(new Card(name, base, capability)), A2aProtocol.AGENT_CARD_PATH);
        context.addServlet(new ServletHolder(new Health()), "/healthz");

        // The verifier only accepts tokens audienced at this agent's own URL.
        TokenVerifier verifier = TokenVerifier.builder(zone).audiences(base).build();
        FilterHolder bearer = new FilterHolder(RequireBearerAuthFilter.builder(verifier)
                .resourceIdentifier(base)
                .build());
        context.addFilter(bearer, A2aProtocol.JSONRPC_PATH, EnumSet.of(DispatcherType.REQUEST));
        context.addServlet(new ServletHolder(new JsonRpc(handler)), A2aProtocol.JSONRPC_PATH);

        Server jetty = new Server(new InetSocketAddress("0.0.0.0", port(self)));
        jetty.setHandler(context);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            try {
                jetty.stop();
            } catch (Exception e) {
                // Exiting anyway.
            }
        }));
        jetty.start();
        System.out.println(name + " listening on " + base);
        jetty.join();
    }

    /** {@code GET /.well-known/agent-card.json}: an A2A 1.0 card with one JSON-RPC interface. */
    static final class Card extends HttpServlet {

        private static final long serialVersionUID = 1L;

        private final String json;

        Card(String name, String base, String capability) {
            Map<String, Object> card = new LinkedHashMap<>();
            card.put("name", name);
            card.put("description", name + " (" + capability + ")");
            card.put("version", "1.0.0");
            card.put("supportedInterfaces", List.of(Map.of(
                    "url", base + A2aProtocol.JSONRPC_PATH,
                    "protocolBinding", "JSONRPC",
                    "protocolVersion", A2aProtocol.PROTOCOL_VERSION)));
            card.put("capabilities", Map.of("streaming", false));
            card.put("defaultInputModes", List.of("text"));
            card.put("defaultOutputModes", List.of("text"));
            card.put("skills", List.of(Map.of(
                    "id", capability, "name", capability, "description", name, "tags", List.of("identity"))));
            this.json = JSONObjectUtils.toJSONString(card);
        }

        @Override
        protected void doGet(HttpServletRequest request, HttpServletResponse response) throws IOException {
            response.setContentType("application/json");
            response.getWriter().write(json);
        }
    }

    /** {@code POST /a2a/jsonrpc}: A2A 1.0 {@code SendMessage} only. */
    static final class JsonRpc extends HttpServlet {

        private static final long serialVersionUID = 1L;

        /** JSON-RPC method not found. */
        private static final int METHOD_NOT_FOUND = -32601;

        /** JSON-RPC parse error. */
        private static final int PARSE_ERROR = -32700;

        /** JSON-RPC internal error, used when delegation fails. */
        private static final int INTERNAL_ERROR = -32603;

        private final transient Handler handler;

        JsonRpc(Handler handler) {
            this.handler = handler;
        }

        @Override
        protected void doPost(HttpServletRequest request, HttpServletResponse response) throws IOException {
            String body = new String(request.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            response.setContentType("application/json");
            Map<String, Object> rpc;
            try {
                rpc = JSONObjectUtils.parse(body);
            } catch (java.text.ParseException e) {
                response.getWriter().write(error(null, PARSE_ERROR, "request is not JSON"));
                return;
            }
            Object id = rpc.get("id");
            if (!A2aProtocol.MESSAGE_SEND_METHOD.equals(rpc.get("method"))
                    || !A2aProtocol.PROTOCOL_VERSION.equals(request.getHeader(A2aProtocol.PROTOCOL_VERSION_HEADER))) {
                response.getWriter().write(error(id, METHOD_NOT_FOUND, "only SendMessage under A2A 1.0"));
                return;
            }
            AccessToken caller = KeycardRequest.accessToken(request).orElseThrow();
            String reply;
            try {
                reply = handler.handle(caller, firstText(rpc));
            } catch (KeycardException e) {
                response.getWriter().write(error(id, INTERNAL_ERROR, e.getClass().getSimpleName() + ": " + e.getMessage()));
                return;
            }
            Map<String, Object> message = new LinkedHashMap<>();
            message.put("messageId", UUID.randomUUID().toString());
            message.put("role", A2aProtocol.ROLE_AGENT);
            message.put("parts", List.of(Map.of("text", reply)));
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("jsonrpc", "2.0");
            out.put("id", id);
            out.put("result", Map.of("message", message));
            response.getWriter().write(JSONObjectUtils.toJSONString(out));
        }

        @SuppressWarnings("unchecked")
        private static String firstText(Map<String, Object> rpc) {
            if (rpc.get("params") instanceof Map<?, ?> params
                    && params.get("message") instanceof Map<?, ?> message
                    && message.get("parts") instanceof List<?> parts) {
                for (Object part : parts) {
                    if (part instanceof Map<?, ?> p && p.get("text") instanceof String text) {
                        return text;
                    }
                }
            }
            return "";
        }

        private static String error(Object id, int code, String message) {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("jsonrpc", "2.0");
            out.put("id", id);
            out.put("error", Map.of("code", code, "message", message));
            return JSONObjectUtils.toJSONString(out);
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

    private static String requireEnv(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            System.err.println(name + " is required. Set it in the environment (see .env.example).");
            System.exit(1);
        }
        return value;
    }

    private static URI baseUrl(String name, String fallback) {
        String value = System.getenv().getOrDefault(name, fallback);
        return URI.create(value.replaceAll("/+$", ""));
    }

    private static int port(URI url) {
        if (url.getPort() != -1) {
            return url.getPort();
        }
        return "https".equals(url.getScheme()) ? 443 : 80;
    }
}
