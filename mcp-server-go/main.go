// Command mcp-server-go is a minimal Keycard-protected MCP server: net/http plus the
// official modelcontextprotocol/go-sdk for the MCP transport, with Keycard providing the
// OAuth metadata endpoints and bearer-token middleware via github.com/keycardai/credentials-go.
//
// It exposes one tool, "hello". The point is the protocol plumbing around it: the
// .well-known OAuth metadata, the bearer middleware that validates Keycard-minted JWTs,
// and Streamable HTTP transport. Configure KEYCARD_URL (the zone's OIDC issuer) and run.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"

	keycardmcp "github.com/keycardai/credentials-go/mcp"
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

	// 1. Build the MCP server and register tools. This is the official SDK only; Keycard
	// is not involved here. Add your own tools alongside hello.
	server := mcp.NewServer(&mcp.Implementation{Name: "mcp-server-go", Version: "1.0.0"}, nil)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "hello",
		Description: "Say hello to a name.",
	}, helloHandler)

	mcpHandler := mcp.NewStreamableHTTPHandler(
		func(*http.Request) *mcp.Server { return server },
		&mcp.StreamableHTTPOptions{},
	)

	// 2. The verifier trusts only tokens issued by this Keycard zone and resolves their
	// signing keys from the zone's JWKS.
	verifier, err := keycardmcp.NewZoneTokenVerifier(keycardURL)
	if err != nil {
		log.Fatalf("building token verifier: %v", err)
	}

	mux := http.NewServeMux()

	// 3a. OAuth metadata so MCP clients can discover how to authenticate.
	mux.Handle("/.well-known/", keycardmcp.AuthMetadataHandler(
		keycardmcp.WithIssuer(keycardURL),
		keycardmcp.WithScopesSupported([]string{"mcp:tools"}),
		keycardmcp.WithResourceName("mcp-server-go"),
	))

	// 3b. Protect /mcp with bearer auth scoped to mcp:tools.
	mux.Handle("/mcp", keycardmcp.RequireBearerAuth(
		verifier,
		keycardmcp.WithRequiredScopes("mcp:tools"),
	)(mcpHandler))

	// 3c. Unauthenticated liveness probe used by the smoke test.
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})

	addr := ":8000"
	if port := os.Getenv("PORT"); port != "" {
		addr = ":" + port
	}
	log.Printf("MCP server running on http://localhost%s/mcp", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func helloHandler(_ context.Context, _ *mcp.ServerSession, params *mcp.CallToolParamsFor[helloInput]) (*mcp.CallToolResultFor[any], error) {
	return &mcp.CallToolResultFor[any]{
		Content: []mcp.Content{&mcp.TextContent{Text: fmt.Sprintf("Hello, %s!", params.Arguments.Name)}},
	}, nil
}
