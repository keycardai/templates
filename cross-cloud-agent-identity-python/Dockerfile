FROM python:3.12-alpine AS base
RUN pip install uv

FROM base AS deps
RUN apk add --no-cache gcc g++ musl-dev libffi-dev openssl-dev curl
WORKDIR /app

COPY pyproject.toml ./
COPY src/ ./src/

RUN uv sync

FROM base AS builder
RUN apk add --no-cache gcc g++ musl-dev libffi-dev openssl-dev
WORKDIR /app

COPY src/ ./src/
COPY pyproject.toml ./

RUN uv build

FROM base AS runner
WORKDIR /app

RUN addgroup --system --gid 1001 appuser
RUN adduser --system --uid 1001 appuser

COPY --from=deps /app/.venv /app/.venv
COPY --from=builder /app/dist/*.whl /tmp/

RUN uv pip install --python /app/.venv/bin/python /tmp/*.whl
RUN rm -rf /tmp/*.whl

RUN chown -R appuser:appuser /app

USER appuser

ENV SERVER_HOST=0.0.0.0
ENV PYTHONUNBUFFERED=1

CMD ["/app/.venv/bin/python", "-m", "agent.server"]
