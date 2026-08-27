# agent-python-langchain

A LangChain agent whose access to Google Calendar is brokered by Keycard: every
tool call gets a short-lived, per-user credential, and every call is audited as a
delegation chain. The agent holds no API keys for the calendar, and the model
never sees a credential.

Sign-in and consent both happen **inside the chat**. Ask the agent something
before signing in and the run pauses with a sign-in link; ask it to write to a
calendar you have only granted read on and it pauses again for consent. Both are
LangGraph interrupts, so any LangGraph-compatible UI renders them.

## What it demonstrates

- `KeycardGrantMiddleware` in a stock `create_agent` agent: one object in the
  middleware list is the whole integration.
- Delegated access at the tool-call boundary (RFC 8693 token exchange per call).
- Pause-for-sign-in and pause-for-consent as LangGraph interrupts.
- The audit trail: user, then application, then resource, per tool call.
- Brokered model access: with the Anthropic federation ids set, the model
  credential is minted for the agent's own identity and no API key is stored.

## Run it

Provision Keycard first (see `SPEC.md`), then:

```bash
uv sync
cp .env.example .env      # fill in the values SPEC.md produced
```

Three processes, in this order:

```bash
uv run python calendar_agent/signin.py --serve    # 1. sign-in + consent page, :8765
uv run langgraph dev --no-browser      # 2. agent server, :2024
```

For a chat window, run LangChain's own UI against it:

```bash
git clone https://github.com/langchain-ai/agent-chat-ui && cd agent-chat-ui
pnpm install && cp .env.example .env && pnpm dev     # :3000
```

Its defaults already point at `http://localhost:2024` with assistant id `agent`.

Order matters: `langgraph dev` reads `.env` at startup, and `signin.py` must stay
running because the agent's interrupt links point at it.

Then open http://localhost:3000 and ask "what's on my calendar today?"

### Without a UI

```bash
curl -s http://127.0.0.1:2024/runs/stream -X POST \
  -H 'Content-Type: application/json' \
  -d '{"assistant_id":"agent","input":{"messages":[{"role":"user","content":"what is on my calendar today?"}]},"stream_mode":"values"}'
```

Same agent, same audit trail. The chat window is a convenience, not the product.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `KEYCARD_ZONE_URL` | none | Your zone, e.g. `https://<zone-id>.keycard.cloud` |
| `KEYCARD_RESOURCE` | `https://www.googleapis.com/calendar/v3` | The Google Calendar resource identifier |
| `KEYCARD_AGENT_RESOURCE` | `http://localhost:2024` | The resource **this agent owns**. User tokens must be addressed here for the agent to be allowed to exchange them. See SPEC.md §1c. |
| `KEYCARD_CLIENT_ID` | none | The agent application's credential identifier |
| `KEYCARD_CLIENT_SECRET` | none | Its secret. Replace with workload identity when deploying. |
| `KEYCARD_AUTHORIZATION_PAGE` | `http://localhost:8765/` | Where interrupts send the user to sign in or consent |
| `KEYCARD_SUBJECT_TOKEN` | none | Written by `signin.py`. The signed-in user for runs that carry no per-run identity. |
| `ANTHROPIC_API_KEY` | none | Model access on the API key path |
| `ANTHROPIC_MODEL` | `claude-opus-5` | Model id |
| `ANTHROPIC_FEDERATION_RULE_ID` | none | The Anthropic federation rule that trusts your zone as an issuer. See SPEC.md §1e. |
| `ANTHROPIC_ORGANIZATION_ID` | none | The Anthropic organization the minted token belongs to |
| `ANTHROPIC_SERVICE_ACCOUNT_ID` | none | The Anthropic service account the federated token acts as |
| `ANTHROPIC_WORKSPACE_ID` | none | The Anthropic workspace the token is scoped to. The Default workspace has no id and cannot be used. |
| `ANTHROPIC_RESOURCE` | `https://api.anthropic.com` | The Keycard resource identifier for Anthropic |

The model runs on workload identity federation when
`ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`,
`ANTHROPIC_SERVICE_ACCOUNT_ID` and `ANTHROPIC_WORKSPACE_ID` are all set, in
which case Keycard mints the model credential per refresh and
`ANTHROPIC_API_KEY` is not read; with any of the four missing it runs on
`ANTHROPIC_API_KEY`.

## Taking this to production

Three things change, and each removes a secret from `.env`:

1. **The agent's credential.** Swap `KEYCARD_CLIENT_ID`/`SECRET` for
   `WorkloadIdentity` from your deployment platform (`FileTokenSource` for
   Kubernetes projected tokens, `GCPMetadataTokenSource` for Cloud Run,
   `FlyTokenSource` for Fly). No static secret.
2. **Per-caller identity.** `KEYCARD_SUBJECT_TOKEN` is a convenience for local
   use: it makes every chat turn act as whoever signed in last. In production the
   user's token arrives per request from your own sign-in and rides
   `context=Access.on_behalf_of(subject_token)`, so two users produce two
   distinct delegation chains.
3. **Model access.** Set the four `ANTHROPIC_*_ID` variables and Keycard brokers
   Anthropic through workload identity federation, which removes
   `ANTHROPIC_API_KEY` as well. `calendar_agent/anthropic_wif.py` holds that
   path, and SPEC.md §1e covers the provisioning. See
   https://docs.keycard.ai/admin/configure-provider-apis/anthropic/

## Notes on the code

`calendar_agent/calendar_tools.py` is worth reading for two habits that matter in agent
tools:

- **Tools own the clock.** They take `days_ahead` rather than an ISO timestamp,
  because a model does not know today's date and will confidently supply the
  wrong one.
- **Tools own their configuration.** The resource comes from the environment,
  never from a tool argument, because a model asked to name a resource will
  eventually invent one.

Both are real bugs caught while building this, not hypotheticals.
