// Command mcp-delegated-access-go is a Keycard-protected MCP server that also brokers
// delegated access: on the user's behalf it exchanges the inbound bearer token for a
// resource-scoped token using its own application credential (RFC 8693 token exchange).
//
// It builds on the mcp-server-go pattern (OAuth metadata + bearer middleware over the
// official modelcontextprotocol/go-sdk) and adds an AuthProvider wired with a ClientSecret
// credential plus a /broker endpoint that demonstrates the Grant token-exchange flow.
//
// Configure KEYCARD_URL (the zone's OIDC issuer), KEYCARD_RESOURCE_ID (this server's
// registered resource, the /mcp endpoint URL), and the application credential
// KEYCARD_CLIENT_ID / KEYCARD_CLIENT_SECRET.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"

	keycardmcp "github.com/keycardai/credentials-go/mcp"
	"github.com/keycardai/credentials-go/oauth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type helloInput struct {
	Name string `json:"name" jsonschema:"the name to greet"`
}

func main() {
	keycardURL := os.Getenv("KEYCARD_URL")
	if keycardURL == "" {
		log.Fatal("KEYCARD_URL environment variable is required (the zone's OIDC issuer URL)")
	}
	// This server's registered resource (the /mcp endpoint URL). Tokens are audience-bound
	// to it, and it is the resource the broker exchanges the user's token for.
	resourceID := os.Getenv("KEYCARD_RESOURCE_ID")
	if resourceID == "" {
		log.Fatal("KEYCARD_RESOURCE_ID environment variable is required (this server's registered resource URL)")
	}
	// The server's own application credential, used to authenticate the token exchange.
	clientID := os.Getenv("KEYCARD_CLIENT_ID")
	clientSecret := os.Getenv("KEYCARD_CLIENT_SECRET")
	if clientID == "" || clientSecret == "" {
		log.Fatal("KEYCARD_CLIENT_ID and KEYCARD_CLIENT_SECRET are required (the server's application credential)")
	}

	// 1. Build the MCP server and register tools (official SDK only; Keycard is not involved here).
	server := mcp.NewServer(&mcp.Implementation{Name: "mcp-delegated-access-go", Version: "1.0.0"}, nil)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "hello",
		Description: "Say hello to a name.",
	}, helloHandler)

	mcpHandler := mcp.NewStreamableHTTPHandler(
		func(*http.Request) *mcp.Server { return server },
		&mcp.StreamableHTTPOptions{},
	)

	// 2. The verifier trusts only tokens issued by this zone, bound to this resource's
	// audience so tokens minted for any other resource are rejected.
	verifier, err := keycardmcp.NewZoneTokenVerifier(keycardURL, oauth.WithAudiences(resourceID))
	if err != nil {
		log.Fatalf("building token verifier: %v", err)
	}

	// 3. The auth provider brokers downstream tokens: it exchanges a user's verified token
	// for a resource-scoped token, authenticating the exchange with the server's own
	// client-secret credential.
	cred, err := keycardmcp.NewClientSecret(clientID, clientSecret)
	if err != nil {
		log.Fatalf("building application credential: %v", err)
	}
	authProvider, err := keycardmcp.NewAuthProvider(
		keycardmcp.WithZoneURL(keycardURL),
		keycardmcp.WithApplicationCredential(cred),
	)
	if err != nil {
		log.Fatalf("building auth provider: %v", err)
	}

	mux := http.NewServeMux()

	// 4a. OAuth metadata so MCP clients can discover how to authenticate.
	mux.Handle("/.well-known/", keycardmcp.AuthMetadataHandler(
		keycardmcp.WithIssuer(keycardURL),
		keycardmcp.WithScopesSupported([]string{"mcp:tools"}),
		keycardmcp.WithResourceName("mcp-delegated-access-go"),
	))

	// 4b. Protect /mcp with bearer auth scoped to mcp:tools.
	mux.Handle("/mcp", keycardmcp.RequireBearerAuth(
		verifier,
		keycardmcp.WithRequiredScopes("mcp:tools"),
	)(mcpHandler))

	// 4c. /broker demonstrates delegated access: bearer auth verifies the user, Grant
	// exchanges that token for a token scoped to resourceID, and the handler reports the
	// brokered result from the AccessContext.
	mux.Handle("/broker", keycardmcp.RequireBearerAuth(
		verifier,
		keycardmcp.WithRequiredScopes("mcp:tools"),
	)(authProvider.Grant([]string{resourceID})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ac := keycardmcp.AccessContextFromRequest(r)

		resp := map[string]any{"status": string(ac.Status())}
		token, accessErr := ac.Access(resourceID)
		if accessErr != nil {
			resp["brokered"] = false
			resp["error"] = accessErr.Error()
		} else {
			resp["brokered"] = true
			resp["resource"] = resourceID
			resp["token_type"] = token.TokenType
			resp["expires_in"] = token.ExpiresIn
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))))

	// 4d. Unauthenticated liveness probe used by the smoke test.
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})

	addr := ":8000"
	if port := os.Getenv("PORT"); port != "" {
		addr = ":" + port
	}
	log.Printf("MCP server (with delegated-access broker) running on http://localhost%s/mcp", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func helloHandler(_ context.Context, _ *mcp.CallToolRequest, in helloInput) (*mcp.CallToolResult, any, error) {
	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: fmt.Sprintf("Hello, %s!", in.Name)}},
	}, nil, nil
}
