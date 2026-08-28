# The agent on Fly Machines. Nothing secret is baked in and nothing is read
# from `fly secrets`: the Keycard credential is the machine's own OIDC token,
# which calendar_agent/agent.py picks up because Fly sets FLY_APP_NAME.
FROM ghcr.io/astral-sh/uv:0.7.9 AS uv

FROM python:3.12-slim

COPY --from=uv /uv /usr/local/bin/uv

WORKDIR /app

COPY pyproject.toml langgraph.json ./
COPY calendar_agent ./calendar_agent

RUN uv sync --no-dev

# langgraph.json points at .env, which is a local-development file and is not
# copied in. On Fly the configuration arrives as real environment variables.
RUN touch .env

EXPOSE 8080

CMD ["uv", "run", "--no-dev", "langgraph", "dev", "--host", "0.0.0.0", "--port", "8080", "--no-browser"]
