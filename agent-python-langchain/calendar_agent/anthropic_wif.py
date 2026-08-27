"""Model access for the agent: Keycard-brokered Anthropic, or an API key.

Two paths, selected by environment:

- Workload identity federation, when `ANTHROPIC_FEDERATION_RULE_ID`,
  `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_SERVICE_ACCOUNT_ID` and
  `ANTHROPIC_WORKSPACE_ID` are all set. Keycard mints a short-lived zone token
  for the agent's own identity, `anthropic.Anthropic` exchanges it for an
  Anthropic access token, and no model key exists anywhere in the deployment.
- `ANTHROPIC_API_KEY`, when any of those four is missing.

The Anthropic resource identifier is `https://api.anthropic.com`, overridable
with `ANTHROPIC_RESOURCE` for a non-default deployment.
"""

from __future__ import annotations

import inspect
import os
from collections.abc import Callable
from functools import cached_property
from typing import Any

import anthropic
from langchain_anthropic import ChatAnthropic
from pydantic import Field

from keycardai.langchain import Access, KeycardGrantMiddleware

ANTHROPIC_RESOURCE = os.environ.get("ANTHROPIC_RESOURCE", "https://api.anthropic.com")

WIF_ENV_VARS = (
    "ANTHROPIC_FEDERATION_RULE_ID",
    "ANTHROPIC_ORGANIZATION_ID",
    "ANTHROPIC_SERVICE_ACCOUNT_ID",
    "ANTHROPIC_WORKSPACE_ID",
)

_SEAM_MEMBERS = ("_client", "_async_client", "_client_params")


def wif_settings() -> dict[str, str] | None:
    """The four federation ids as `WorkloadIdentityCredentials` kwargs.

    `None` means the API key path applies: federation needs all four, and a
    partial set is a misconfiguration rather than a reason to half-enable it.
    """
    values = {name: os.environ.get(name, "").strip() for name in WIF_ENV_VARS}
    if not all(values.values()):
        return None
    return {
        name.removeprefix("ANTHROPIC_").lower(): value for name, value in values.items()
    }


def identity_token_provider(keycard: KeycardGrantMiddleware) -> Callable[[], str]:
    """A callable that returns a fresh Keycard zone token on every invocation.

    The token is the identity assertion Anthropic exchanges for an Anthropic
    access token. It is deliberately not cached here: a zone token carries a
    `jti` and Anthropic enforces single-use exchange, so a reused token fails
    the next exchange. `anthropic.Anthropic` caches the exchanged Anthropic
    token and calls this only when it needs to refresh.
    """

    def provide() -> str:
        with keycard.grant(Access.as_self(), resources=[ANTHROPIC_RESOURCE]) as access:
            return access.access(ANTHROPIC_RESOURCE).access_token

    return provide


class ChatAnthropicWithCredentials(ChatAnthropic):
    """Temporary bridge that hands an Anthropic credentials provider to the SDK.

    `ChatAnthropic` builds its clients from `_client_params`, which carries an
    `api_key` and no credentials provider. This subclass overrides the two
    cached properties that construct those clients, `_client` and
    `_async_client`, and swaps the `api_key` entry for `credentials=` so both
    the sync and async client authenticate through workload identity
    federation. Everything else in `_client_params` (base URL, retries,
    headers, timeout) is passed through unchanged.

    Delete this subclass once langchain-anthropic accepts a credentials
    passthrough of its own (tracked as ECO-327), and construct `ChatAnthropic`
    directly.
    """

    credentials: Any = Field(default=None, exclude=True)
    """The `anthropic.AccessTokenProvider` both clients authenticate with."""

    def _credentialed_params(self) -> dict[str, Any]:
        params = {k: v for k, v in self._client_params.items() if k != "api_key"}
        params["credentials"] = self.credentials
        return params

    @cached_property
    def _client(self) -> anthropic.Client:
        return anthropic.Client(**self._credentialed_params())

    @cached_property
    def _async_client(self) -> anthropic.AsyncClient:
        return anthropic.AsyncClient(**self._credentialed_params())


def assert_client_seam() -> None:
    """Raise if the construction seam `ChatAnthropicWithCredentials` overrides is gone.

    The bridge is only effective while `ChatAnthropic` builds its clients in
    the `_client` and `_async_client` cached properties from a `_client_params`
    mapping, and while `anthropic.Client` takes `credentials=`. If any of those
    moves, the override silently stops applying and requests would go out with
    no credential, so fail here instead.
    """
    for name in _SEAM_MEMBERS:
        member = ChatAnthropic.__dict__.get(name)
        if not isinstance(member, cached_property):
            raise RuntimeError(
                f"langchain-anthropic no longer defines ChatAnthropic.{name} as a "
                "cached_property. ChatAnthropicWithCredentials in "
                "calendar_agent/anthropic_wif.py overrides that seam to pass "
                "credentials=: re-point the override at the current construction "
                "site, or delete the subclass if ChatAnthropic now accepts a "
                "credentials provider directly."
            )
    for client_type in (anthropic.Client, anthropic.AsyncClient):
        if "credentials" not in inspect.signature(client_type.__init__).parameters:
            raise RuntimeError(
                f"anthropic.{client_type.__name__} no longer accepts credentials=, "
                "so the workload identity federation path in "
                "calendar_agent/anthropic_wif.py cannot authenticate."
            )
    params = ChatAnthropic(model="claude-opus-5", api_key="seam-check")._client_params
    if "api_key" not in params:
        raise RuntimeError(
            "ChatAnthropic._client_params no longer carries an api_key entry, which "
            "ChatAnthropicWithCredentials replaces with credentials=. Check what the "
            "clients now authenticate with."
        )


def build_model(
    keycard: KeycardGrantMiddleware,
    *,
    model: str,
    max_tokens: int,
) -> ChatAnthropic:
    """The chat model for the agent, on whichever access path is configured.

    With the four federation ids set, the model authenticates with a token
    Keycard mints for the agent application and no `ANTHROPIC_API_KEY` is
    read. Otherwise `ChatAnthropic` reads `ANTHROPIC_API_KEY` as usual.
    """
    settings = wif_settings()
    if settings is None:
        return ChatAnthropic(model=model, max_tokens=max_tokens)

    assert_client_seam()
    credentials = anthropic.WorkloadIdentityCredentials(
        identity_token_provider=identity_token_provider(keycard),
        **settings,
    )
    return ChatAnthropicWithCredentials(
        model=model,
        max_tokens=max_tokens,
        credentials=credentials,
    )
