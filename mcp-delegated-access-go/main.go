// Command mcp-delegated-access-go is a Keycard-protected MCP server that also brokers
// delegated access: on the user's behalf it exchanges the inbound bearer token for a
// resource-scoped token using its own application credential (RFC 8693 token exchange).
//
// It builds on the mcp-server-go pattern (OAuth metadata + bearer middleware over the
// official modelcontextprotocol/go-sdk) and adds a token exchange client wired with a
// client-secret credential plus a /broker endpoint.
//
// Configure KEYCARD_URL (the zone's OIDC issuer), KEYCARD_RESOURCE_ID (this server's
// registered resource, the /mcp endpoint URL), and the application credential
// KEYCARD_CLIENT_ID / KEYCARD_CLIENT_SECRET.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"

	keycardmcp "github.com/keycardai/go-sdk/mcp"
	"github.com/keycardai/go-sdk/oauth"
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
	port := os.Getenv("PORT")
	if port == "" {
		port = "8000"
	}
	// This server's registered resource (the /mcp endpoint URL). Tokens are audience-bound
	// to it, and it is the resource the broker exchanges the user's token for.
	resourceID := os.Getenv("KEYCARD_RESOURCE_ID")
	if resourceID == "" {
		resourceID = "http://localhost:" + port + "/mcp"
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

	// 2. Use the registered resource for the token audience, metadata, and challenge.
	binding, err := keycardmcp.NewResourceBinding(keycardURL, keycardmcp.WithResourceIdentifier(resourceID))
	if err != nil {
		log.Fatalf("building resource binding: %v", err)
	}
	requireBearer, err := binding.BearerAuth(keycardmcp.WithRequiredScopes("mcp:tools"))
	if err != nil {
		log.Fatalf("building bearer middleware: %v", err)
	}

	// 3. Configure the exchange client with the server's own credential.
	cred, err := oauth.NewClientSecret(clientID, clientSecret)
	if err != nil {
		log.Fatalf("building application credential: %v", err)
	}
	exchangeClient := oauth.NewTokenExchangeClient(keycardURL, oauth.WithTokenExchangeCredential(cred))

	mux := http.NewServeMux()

	// 4a. OAuth metadata so MCP clients can discover how to authenticate.
	mux.Handle("/.well-known/", binding.MetadataHandler(
		keycardmcp.WithScopesSupported([]string{"mcp:tools"}),
		keycardmcp.WithResourceName("mcp-delegated-access-go"),
	))

	// 4b. Protect /mcp with bearer auth scoped to mcp:tools.
	mux.Handle("/mcp", requireBearer(mcpHandler))

	// 4c. Verify the caller before attempting delegated token exchange.
	mux.Handle("/broker", requireBearer(brokerHandler(exchangeClient, resourceID)))

	// 4d. Unauthenticated liveness probe used by the smoke test.
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})

	addr := ":" + port
	log.Printf("Protected resource: %s (set KEYCARD_RESOURCE_ID to the public /mcp URL when not on localhost)", resourceID)
	log.Printf("MCP server (with delegated-access broker) running on http://localhost%s/mcp", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func brokerHandler(client *oauth.TokenExchangeClient, resourceID string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		caller := keycardmcp.AuthInfoFromRequest(r)
		token, err := client.ExchangeToken(r.Context(), oauth.TokenExchangeRequest{
			SubjectToken: caller.Token,
			Resource:     resourceID,
		})

		resp := map[string]any{"status": oauth.StatusSuccess, "brokered": err == nil}
		if err != nil {
			resp["status"] = oauth.StatusPartialError
			resp["error"] = fmt.Sprintf("Token exchange failed for %s", resourceID)
			resp["error_code"], resp["error_description"], resp["raw_error"] = "", "", ""
			var oauthErr *oauth.OAuthError
			if errors.As(err, &oauthErr) {
				resp["error_code"] = oauthErr.ErrorCode
				resp["error_description"] = oauthErr.Message
				if oauthErr.ErrorDescription != nil {
					resp["error_description"] = *oauthErr.ErrorDescription
				}
			} else {
				resp["raw_error"] = err.Error()
			}
		} else {
			resp["resource"] = resourceID
			resp["token_type"] = token.TokenType
			resp["expires_in"] = token.ExpiresIn
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}
}

func helloHandler(_ context.Context, _ *mcp.CallToolRequest, in helloInput) (*mcp.CallToolResult, any, error) {
	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: fmt.Sprintf("Hello, %s!", in.Name)}},
	}, nil, nil
}
