package example;

import ai.keycard.a2a.A2aProtocol;
import ai.keycard.a2a.DelegationClient;
import ai.keycard.mcp.AuthProvider;
import ai.keycard.mcp.KeycardRequest;
import ai.keycard.mcp.RequireBearerAuthFilter;
import ai.keycard.oauth.AccessToken;
import ai.keycard.oauth.ClientSecret;
import ai.keycard.oauth.KeycardException;
import com.google.protobuf.util.JsonFormat;
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
import java.util.function.BiFunction;
import org.a2aproject.sdk.grpc.utils.JSONRPCUtils;
import org.a2aproject.sdk.grpc.utils.ProtoJsonUtils;
import org.a2aproject.sdk.grpc.utils.ProtoUtils;
import org.a2aproject.sdk.jsonrpc.common.wrappers.A2ARequest;
import org.a2aproject.sdk.jsonrpc.common.wrappers.SendMessageRequest;
import org.a2aproject.sdk.spec.AgentCapabilities;
import org.a2aproject.sdk.spec.AgentCard;
import org.a2aproject.sdk.spec.AgentInterface;
import org.a2aproject.sdk.spec.AgentSkill;
import org.a2aproject.sdk.spec.Message;
import org.a2aproject.sdk.spec.MethodNotFoundError;
import org.a2aproject.sdk.spec.Part;
import org.a2aproject.sdk.spec.TextPart;
import org.a2aproject.sdk.spec.VersionNotSupportedError;
import org.eclipse.jetty.ee10.servlet.FilterHolder;
import org.eclipse.jetty.ee10.servlet.ServletContextHandler;
import org.eclipse.jetty.ee10.servlet.ServletHolder;
import org.eclipse.jetty.server.Server;

/** Runs one of the two A2A agents. Each verifies tokens for its own resource URL. */
public final class Agent {

    private static final String RPC_PATH = "/a2a/jsonrpc";
    private static final String VERSION = "1.0";

    private Agent() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 1 || !List.of("caller", "target").contains(args[0])) {
            throw new IllegalArgumentException("Usage: a2a-delegation-java caller|target");
        }
        boolean caller = "caller".equals(args[0]);
        String name = "a2a-delegation-" + args[0];
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", caller ? "9100" : "9101"));
        URI zone = URI.create(requiredEnv("KEYCARD_URL"));
        URI baseUrl = baseUrl(caller ? "CALLER_BASE_URL" : "TARGET_BASE_URL");
        AuthProvider auth = AuthProvider.builder(zone).resourceIdentifier(baseUrl.toString()).build();

        BiFunction<AccessToken, Message, String> answer;
        if (caller) {
            URI target = baseUrl("TARGET_BASE_URL");
            DelegationClient delegation = DelegationClient.builder(zone)
                    .credential(ClientSecret.of(requiredEnv("KEYCARD_CLIENT_ID"), requiredEnv("KEYCARD_CLIENT_SECRET")))
                    .build();
            answer = (user, message) -> delegation.invoke(target, user.token(), A2aProtocol.textMessage(firstText(message)))
                    .text()
                    .orElseThrow(() -> new IllegalStateException("The target returned no message text"));
        } else {
            answer = (user, message) -> {
                Map<String, Object> report = new LinkedHashMap<>();
                report.put("sub", user.subject());
                report.put("act", user.claims().get("act"));
                report.put("aud", user.audiences());
                return JSONObjectUtils.toJSONString(report);
            };
        }

        ServletContextHandler context = new ServletContextHandler();
        context.addServlet(new ServletHolder(new JsonDocument("{\"status\":\"ok\"}")), "/healthz");
        context.addServlet(new ServletHolder(new JsonDocument(card(name, baseUrl, caller))), "/.well-known/agent-card.json");
        context.addServlet(new ServletHolder(auth.protectedResourceMetadata().resourceName(name).build()),
                "/.well-known/oauth-protected-resource/*");
        context.addServlet(new ServletHolder(auth.authorizationServerMetadata()), "/.well-known/oauth-authorization-server");
        context.addFilter(new FilterHolder(RequireBearerAuthFilter.builder(auth).build()), RPC_PATH,
                EnumSet.of(DispatcherType.REQUEST));
        context.addServlet(new ServletHolder(new JsonRpc(answer)), RPC_PATH);

        Server jetty = new Server(new InetSocketAddress("0.0.0.0", port));
        jetty.setHandler(context);
        jetty.setStopAtShutdown(true);
        jetty.start();
        System.out.println(name + " listening on http://localhost:" + port + RPC_PATH);
        jetty.join();
    }

    private static String requiredEnv(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " environment variable is required");
        }
        return value;
    }

    private static URI baseUrl(String name) {
        URI url = URI.create(requiredEnv(name)).normalize();
        if (!("http".equals(url.getScheme()) || "https".equals(url.getScheme())) || url.getHost() == null
                || url.getUserInfo() != null || url.getQuery() != null || url.getFragment() != null
                || !(url.getPath().isEmpty() || "/".equals(url.getPath()))) {
            throw new IllegalArgumentException(name + " must be an HTTP(S) origin");
        }
        return URI.create(url.toString().replaceFirst("/$", ""));
    }

    private static String card(String name, URI baseUrl, boolean caller) throws IOException {
        String description = caller ? "Delegates a message to the target" : "Reports the verified user and actor chain";
        AgentCard card = AgentCard.builder()
                .name(name)
                .description(description)
                .version("1.0.0")
                .capabilities(AgentCapabilities.builder().streaming(false).build())
                .defaultInputModes(List.of("text"))
                .defaultOutputModes(List.of("text"))
                .skills(List.of(AgentSkill.builder()
                        .id(caller ? "delegate" : "whoami")
                        .name(caller ? "Delegate to target" : "Who am I")
                        .description(description)
                        .tags(List.of("identity"))
                        .build()))
                .supportedInterfaces(List.of(new AgentInterface("JSONRPC", baseUrl + RPC_PATH, null, VERSION)))
                .build();
        return ProtoJsonUtils.toJson(JsonFormat.printer(), ProtoUtils.ToProto.agentCard(card));
    }

    private static String firstText(Message message) {
        for (Part<?> part : message.parts()) {
            if (part instanceof TextPart text) {
                return text.text();
            }
        }
        return "";
    }

    private static final class JsonDocument extends HttpServlet {

        private static final long serialVersionUID = 1L;
        private final String json;

        JsonDocument(String json) {
            this.json = json;
        }

        @Override
        protected void doGet(HttpServletRequest request, HttpServletResponse response) throws IOException {
            response.setContentType("application/json");
            response.setCharacterEncoding(StandardCharsets.UTF_8.name());
            response.getWriter().write(json);
        }
    }

    private static final class JsonRpc extends HttpServlet {

        private static final long serialVersionUID = 1L;
        private static final int MAX_REQUEST_BYTES = 1024 * 1024;
        private final transient BiFunction<AccessToken, Message, String> answer;

        JsonRpc(BiFunction<AccessToken, Message, String> answer) {
            this.answer = answer;
        }

        @Override
        protected void doPost(HttpServletRequest request, HttpServletResponse response) throws IOException {
            if (request.getContentLengthLong() > MAX_REQUEST_BYTES) {
                response.sendError(HttpServletResponse.SC_REQUEST_ENTITY_TOO_LARGE);
                return;
            }
            byte[] body = request.getInputStream().readNBytes(MAX_REQUEST_BYTES + 1);
            if (body.length > MAX_REQUEST_BYTES) {
                response.sendError(HttpServletResponse.SC_REQUEST_ENTITY_TOO_LARGE);
                return;
            }
            response.setContentType("application/json");
            response.setCharacterEncoding(StandardCharsets.UTF_8.name());
            A2ARequest<?> rpc;
            try {
                rpc = JSONRPCUtils.parseRequestBody(new String(body, StandardCharsets.UTF_8), null);
            } catch (Exception e) {
                response.getWriter().write(JSONRPCUtils.toJsonRPCErrorResponse(
                        null, new MethodNotFoundError(null, "Could not read the JSON-RPC request", null)));
                return;
            }
            String version = request.getHeader("A2A-Version");
            if (version == null) {
                version = request.getParameter("A2A-Version");
            }
            if (!VERSION.equals(version)) {
                response.getWriter().write(JSONRPCUtils.toJsonRPCErrorResponse(
                        rpc.getId(), new VersionNotSupportedError(null, "Only A2A 1.0 is supported", null)));
                return;
            }
            if (!(rpc instanceof SendMessageRequest send)) {
                response.getWriter().write(JSONRPCUtils.toJsonRPCErrorResponse(
                        rpc.getId(), new MethodNotFoundError(null, "Only SendMessage is supported", null)));
                return;
            }

            AccessToken user = KeycardRequest.accessToken(request).orElseThrow();
            String text;
            try {
                text = answer.apply(user, send.getParams().message());
            } catch (KeycardException | IllegalStateException e) {
                response.sendError(HttpServletResponse.SC_BAD_GATEWAY, "Delegation failed");
                return;
            }
            Message reply = Message.builder()
                    .role(Message.Role.ROLE_AGENT)
                    .parts(new TextPart(text, null))
                    .messageId(UUID.randomUUID().toString())
                    .build();
            response.getWriter().write(JSONRPCUtils.toJsonRPCResultResponse(
                    send.getId(), ProtoUtils.ToProto.taskOrMessage(reply)));
        }
    }
}
