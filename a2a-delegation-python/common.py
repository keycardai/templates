"""Shared wiring for the two agents: environment, agent-card construction, and
the Keycard-protected Starlette composition from keycardai-a2a's
keycard_protected_server example.

Each agent is a plain a2a-sdk 1.x server. keycardai-a2a adds the pieces that
make it Keycard-aware: a bearer verifier bound to the agent's own resource,
a call-context builder that hands the verified caller to the executor, and
(in the caller) the delegation client that exchanges the user's token for the
target.
"""

import base64
import json
import os
import uuid
from urllib.parse import urlparse

from a2a.server.agent_execution import AgentExecutor
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes
from a2a.server.tasks import InMemoryTaskStore
from a2a.types import Message, Part, Role
from dotenv import find_dotenv, load_dotenv
from keycardai.a2a import AgentServiceConfig, KeycardServerCallContextBuilder, build_agent_card_from_config
from keycardai.starlette import AuthProvider, KeycardAuthBackend, keycard_on_error
from keycardai.starlette.routers.metadata import auth_metadata_mount
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.authentication import AuthenticationMiddleware
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route

load_dotenv(find_dotenv(usecwd=True))


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required. Set it in .env (see .env.example).")
    return value


KEYCARD_URL = require_env("KEYCARD_URL")
CALLER_BASE_URL = os.environ.get("CALLER_BASE_URL", "http://localhost:9100").rstrip("/")
TARGET_BASE_URL = os.environ.get("TARGET_BASE_URL", "http://localhost:9101").rstrip("/")


def zone_id_from_issuer(issuer: str) -> str:
    """The zone id is the first DNS label of the zone issuer host."""
    host = urlparse(issuer).hostname or issuer
    return host.split(".")[0]


def decode_claims(token: str) -> dict:
    """Read the payload of an already verified JWT.

    The verifier has checked the signature, issuer, audience, and expiry before
    the executor runs; this only decodes the claims it does not surface as
    attributes (the act chain and the audience list).
    """
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(payload))


def agent_message(text: str) -> Message:
    return Message(message_id=str(uuid.uuid4()), role=Role.ROLE_AGENT, parts=[Part(text=text)])


def service_config(name: str, identity_url: str, client_id: str, client_secret: str, capability: str) -> AgentServiceConfig:
    return AgentServiceConfig(
        service_name=name,
        client_id=client_id,
        client_secret=client_secret,
        identity_url=identity_url,
        zone_id=zone_id_from_issuer(KEYCARD_URL),
        authorization_server_url=KEYCARD_URL,
        description=f"{name} ({capability})",
        capabilities=[capability],
    )


def build_app(config: AgentServiceConfig, executor: AgentExecutor) -> Starlette:
    """Compose a Keycard-protected A2A agent.

    The bearer verifier is bound to the agent's own identity URL, which is the
    resource identifier registered for it in the zone, so a zone token minted
    for any other resource is refused with a 401 invalid_token challenge.
    """
    auth_provider = AuthProvider(
        zone_url=KEYCARD_URL,
        server_name=config.service_name,
        server_url=config.identity_url,
        audience=config.identity_url,
    )
    verifier = auth_provider.get_token_verifier()
    strict_auth = Middleware(
        AuthenticationMiddleware,
        backend=KeycardAuthBackend(verifier, require_authentication=True),
        on_error=keycard_on_error,
    )

    agent_card = build_agent_card_from_config(config)
    request_handler = DefaultRequestHandler(
        agent_executor=executor,
        task_store=InMemoryTaskStore(),
        agent_card=agent_card,
    )

    async def healthz(request):
        return JSONResponse({"ok": True, "name": config.service_name})

    return Starlette(
        routes=[
            Route("/healthz", healthz, methods=["GET"]),
            *create_agent_card_routes(agent_card=agent_card),
            auth_metadata_mount(KEYCARD_URL),
            Mount(
                "/a2a",
                routes=create_jsonrpc_routes(
                    request_handler=request_handler,
                    rpc_url="/jsonrpc",
                    context_builder=KeycardServerCallContextBuilder(),
                ),
                middleware=[strict_auth],
            ),
        ]
    )
