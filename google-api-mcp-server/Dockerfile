FROM ghcr.io/astral-sh/uv:python3.11-alpine AS base

FROM base AS deps
RUN apk add --no-cache \
    gcc \
    musl-dev \
    libffi-dev \
    openssl-dev \
    curl
WORKDIR /app

# Copy all necessary files for package installation
COPY pyproject.toml uv.lock ./
COPY src/ ./src/
COPY README.md ./
COPY LICENSE ./

# Install production dependencies
RUN uv sync

FROM base AS dev
RUN apk add --no-cache \
    gcc \
    musl-dev \
    libffi-dev \
    openssl-dev \
    curl \
    git \
    bash
WORKDIR /app

# Copy all necessary files for package installation
COPY pyproject.toml uv.lock ./
COPY src/ ./src/
COPY README.md ./
COPY LICENSE ./

# Install dependencies including dev dependencies
RUN uv sync

# Copy MCP keys
COPY mcp_keys/ ./mcp_keys/

ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=7878
ENV PYTHONPATH=/app/src

EXPOSE 7878

CMD ["uv", "run", "-m", "google_api_mcp_server"]

# Build stage for creating wheel package
FROM base AS builder
RUN apk add --no-cache \
    gcc \
    musl-dev \
    libffi-dev \
    openssl-dev
WORKDIR /app

# Copy source code and build configuration
COPY src/ ./src/
COPY pyproject.toml ./
COPY README.md ./
COPY LICENSE ./

# Build the wheel package
RUN uv build

FROM base AS runner
WORKDIR /app

RUN addgroup --system --gid 1001 appuser
RUN adduser --system --uid 1001 appuser

COPY --from=deps /app/.venv /app/.venv

# Copy the built wheel from builder stage
COPY --from=builder /app/dist/*.whl /tmp/

# Install the wheel package (clean production install)
RUN uv pip install --python /app/.venv/bin/python /tmp/*.whl

# Copy MCP keys directory if it exists
COPY mcp_keys/ ./mcp_keys/

# Clean up temporary files
RUN rm -rf /tmp/*.whl

# Change ownership to the app user
RUN chown -R appuser:appuser /app

USER appuser

# Set environment variables
ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=7878

EXPOSE 7878

# Use UV to run the installed package
CMD ["uv", "run", "--python", "/app/.venv/bin/python", "-m", "google_api_mcp_server"]
