"""Target agent: verifies the inbound Keycard token bound to its own resource
and answers with the identity claims it received.

Run with uvicorn:

    uv run uvicorn target_agent:app --host 0.0.0.0 --port 9101

There is no model call. The reply is a JSON document with the verified
token's ``sub`` (the user), ``act`` (the delegation chain the zone recorded at
token exchange: ``act.sub`` names the calling agent's application), and
``aud`` (the audience, which is this agent only).
"""

import json
import os

from a2a.server.agent_execution import AgentExecutor
from a2a.server.events.event_queue_v2 import EventQueue
from keycardai.a2a import keycard_user

from common import TARGET_BASE_URL, agent_message, build_app, decode_claims, service_config

SERVICE_NAME = "a2a-delegation-target"


class ClaimsEchoExecutor(AgentExecutor):
    async def execute(self, context, event_queue: EventQueue) -> None:
        caller = keycard_user(context)
        if caller is None:
            raise PermissionError("unauthenticated")
        claims = decode_claims(caller.access_token)
        report = {
            "received": context.get_user_input(),
            "sub": claims.get("sub"),
            "act": claims.get("act"),
            "aud": claims.get("aud"),
            "client_id": caller.client_id,
        }
        await event_queue.enqueue_event(agent_message(json.dumps(report)))

    async def cancel(self, context, event_queue: EventQueue) -> None:
        return None


config = service_config(
    name=SERVICE_NAME,
    identity_url=TARGET_BASE_URL,
    client_id=os.environ.get("TARGET_CLIENT_ID", "target"),
    client_secret=os.environ.get("TARGET_CLIENT_SECRET", "unused"),
    capability="report_identity",
)
app = build_app(config, ClaimsEchoExecutor())

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("TARGET_PORT", "9101")))
