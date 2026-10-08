"""Caller agent: accepts a user's token, delegates to the target on the user's
behalf, and returns the target's answer.

Run with uvicorn:

    uv run uvicorn caller_agent:app --host 0.0.0.0 --port 9100

The delegated call is the contract in keycard-sdk-spec's a2a-delegation.md:
discover the target through its agent card, exchange the user's token for
one scoped to the target (RFC 8693, resource = the target, authenticated with
this agent's own application credential), and invoke the target with it. The
user stays the subject; the zone adds this application to the token's ``act``
chain. There is no model call.
"""

import os

from a2a.server.agent_execution import AgentExecutor
from a2a.server.events.event_queue_v2 import EventQueue
from keycardai.a2a import DelegationClient, ServiceDiscovery, keycard_user

from common import CALLER_BASE_URL, TARGET_BASE_URL, agent_message, build_app, require_env, service_config

SERVICE_NAME = "a2a-delegation-caller"

config = service_config(
    name=SERVICE_NAME,
    identity_url=CALLER_BASE_URL,
    client_id=require_env("KEYCARD_CLIENT_ID"),
    client_secret=require_env("KEYCARD_CLIENT_SECRET"),
    capability="delegate",
)
discovery = ServiceDiscovery(config)
delegation = DelegationClient(config)


class DelegatingExecutor(AgentExecutor):
    async def execute(self, context, event_queue: EventQueue) -> None:
        caller = keycard_user(context)
        if caller is None:
            raise PermissionError("unauthenticated")
        card = await discovery.get_service_card(TARGET_BASE_URL)
        result = await delegation.invoke_service(
            TARGET_BASE_URL,
            context.get_user_input(),
            subject_token=caller.access_token,
        )
        await event_queue.enqueue_event(
            agent_message(f"{card['name']} answered: {result['result']}")
        )

    async def cancel(self, context, event_queue: EventQueue) -> None:
        return None


app = build_app(config, DelegatingExecutor())

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("CALLER_PORT", "9100")))
