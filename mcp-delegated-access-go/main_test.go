package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	keycardmcp "github.com/keycardai/go-sdk/mcp"
	"github.com/keycardai/go-sdk/oauth"
)

func TestBrokerExchange(t *testing.T) {
	const resource = "https://mcp.example.com/mcp"
	const subject = "caller-token"
	credential, err := oauth.NewClientSecret("broker-client", "broker-secret")
	if err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name        string
		tokenStatus int
		tokenBody   string
		want        map[string]any
	}{
		{
			name:        "success",
			tokenStatus: http.StatusOK,
			tokenBody:   `{"access_token":"delegated-token","token_type":"Bearer","expires_in":3600}`,
			want:        map[string]any{"status": "success", "brokered": true, "resource": resource, "token_type": "Bearer", "expires_in": float64(3600)},
		},
		{
			name:        "exchange rejected",
			tokenStatus: http.StatusBadRequest,
			tokenBody:   `{"error":"invalid_target","error_description":"resource not allowed"}`,
			want: map[string]any{
				"status": "error", "brokered": false, "error": "Token exchange failed for " + resource,
				"error_code": "invalid_target", "error_description": "resource not allowed", "raw_error": "",
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			issuer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/.well-known/oauth-authorization-server":
					_ = json.NewEncoder(w).Encode(map[string]string{
						"issuer":         "http://" + r.Host,
						"token_endpoint": "http://" + r.Host + "/token",
					})
				case "/token":
					id, secret, ok := r.BasicAuth()
					if !ok || id != "broker-client" || secret != "broker-secret" {
						t.Error("expected the client credential via HTTP Basic")
					}
					if r.Method != http.MethodPost ||
						r.PostFormValue("grant_type") != "urn:ietf:params:oauth:grant-type:token-exchange" ||
						r.PostFormValue("subject_token") != subject || r.PostFormValue("resource") != resource ||
						r.PostFormValue("client_id") != "" || r.PostFormValue("client_secret") != "" {
						t.Error("unexpected exchange request")
					}
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(tc.tokenStatus)
					_, _ = io.WriteString(w, tc.tokenBody)
				default:
					http.NotFound(w, r)
				}
			}))
			defer issuer.Close()

			client := oauth.NewTokenExchangeClient(issuer.URL, oauth.WithTokenExchangeCredential(credential))
			r := httptest.NewRequest(http.MethodGet, "/broker", nil)
			r = r.WithContext(keycardmcp.ContextWithAuthInfo(r.Context(), &keycardmcp.AuthInfo{Token: subject}))
			w := httptest.NewRecorder()
			brokerHandler(client, resource).ServeHTTP(w, r)

			var got map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if w.Code != http.StatusOK || !reflect.DeepEqual(got, tc.want) {
				t.Errorf("got status %d and response %v, want status 200 and response %v", w.Code, got, tc.want)
			}
		})
	}
}
