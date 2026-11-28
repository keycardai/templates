package example;

import ai.keycard.spring.boot.KeycardResourceServer;
import io.modelcontextprotocol.server.McpServerFeatures.SyncToolSpecification;
import io.modelcontextprotocol.spec.McpSchema.CallToolResult;
import io.modelcontextprotocol.spec.McpSchema.Tool;
import java.util.List;
import java.util.Map;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** A Spring AI WebMVC MCP server using the Keycard Spring Boot starter. */
@SpringBootApplication
@RestController
public class Application {

    public static void main(String[] args) {
        String issuer = System.getenv("KEYCARD_URL");
        if (issuer == null || issuer.isBlank()) {
            throw new IllegalArgumentException("KEYCARD_URL environment variable is required");
        }
        String resource = System.getenv("KEYCARD_RESOURCE_ID");
        SpringApplication app = new SpringApplication(Application.class);
        app.setDefaultProperties(Map.of("keycard.resource-identifier",
                resource == null || resource.isBlank() ? "http://localhost:${server.port}/mcp" : resource));
        app.run(args);
    }

    @Bean
    SecurityFilterChain keycardSecurity(HttpSecurity http, KeycardResourceServer keycard) throws Exception {
        return http
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers("/mcp").hasAuthority("SCOPE_mcp:tools")
                        .anyRequest().permitAll())
                .csrf(csrf -> csrf.disable())
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .with(keycard, Customizer.withDefaults())
                .build();
    }

    @Bean
    List<SyncToolSpecification> tools() {
        Tool hello = Tool.builder("hello", Map.of(
                        "type", "object",
                        "properties", Map.of("name", Map.of("type", "string", "description", "the name to greet"))))
                .description("Say hello to a name.")
                .build();

        return List.of(SyncToolSpecification.builder()
                .tool(hello)
                .callHandler((exchange, request) -> {
                    Object name = request.arguments() == null ? null : request.arguments().get("name");
                    String greeting = "Hello, " + (name instanceof String s && !s.isBlank() ? s : "world") + "!";
                    return CallToolResult.builder().addTextContent(greeting).isError(false).build();
                })
                .build());
    }

    @GetMapping("/healthz")
    Map<String, String> health() {
        return Map.of("status", "ok");
    }
}
