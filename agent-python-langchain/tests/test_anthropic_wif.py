"""Guards on the two model access paths and on the langchain-anthropic seam."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import anthropic
import pytest
from langchain_anthropic import ChatAnthropic

from calendar_agent.anthropic_wif import (
    WIF_ENV_VARS,
    ChatAnthropicWithCredentials,
    assert_client_seam,
    build_model,
    identity_token_provider,
    wif_settings,
)


class FakeMiddleware:
    """A stand-in for KeycardGrantMiddleware that mints numbered tokens."""

    def __init__(self) -> None:
        self.grants: list[list[str]] = []

    @contextmanager
    def grant(self, identity: Any, *, resources: list[str]) -> Iterator[Any]:
        self.grants.append(resources)
        issued = f"zone-token-{len(self.grants)}"

        class Token:
            access_token = issued

        class Access:
            def access(self, resource: str) -> Token:
                return Token()

        yield Access()


@pytest.fixture
def wif_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_FEDERATION_RULE_ID", "fedrule_test")
    monkeypatch.setenv(
        "ANTHROPIC_ORGANIZATION_ID", "11111111-2222-3333-4444-555555555555"
    )
    monkeypatch.setenv("ANTHROPIC_SERVICE_ACCOUNT_ID", "svcacct_test")
    monkeypatch.setenv("ANTHROPIC_WORKSPACE_ID", "wrkspc_test")


def test_seam_is_intact() -> None:
    assert_client_seam()


def test_wif_settings_requires_all_four(
    wif_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert wif_settings() == {
        "federation_rule_id": "fedrule_test",
        "organization_id": "11111111-2222-3333-4444-555555555555",
        "service_account_id": "svcacct_test",
        "workspace_id": "wrkspc_test",
    }
    for name in WIF_ENV_VARS:
        monkeypatch.delenv(name)
        assert wif_settings() is None
        monkeypatch.setenv(name, "set-again")


def test_api_key_path_without_wif_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in WIF_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-placeholder-never-called")

    model = build_model(FakeMiddleware(), model="claude-opus-5", max_tokens=64)

    assert type(model) is ChatAnthropic
    assert model._client.api_key == "test-placeholder-never-called"
    assert model._client.credentials is None


def test_wif_path_credentials_reach_both_clients(
    wif_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Both clients authenticate with the provider, and no API key is used.

    The provider is not invoked while building the clients: the exchange
    happens on the first request.
    """
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    keycard = FakeMiddleware()

    model = build_model(keycard, model="claude-opus-5", max_tokens=64)

    assert isinstance(model, ChatAnthropicWithCredentials)
    assert isinstance(model.credentials, anthropic.WorkloadIdentityCredentials)
    for client in (model._client, model._async_client):
        assert client.api_key is None
        assert client.credentials is not None
    assert keycard.grants == []


def test_identity_token_provider_grants_per_call(wif_env: None) -> None:
    """A fresh Keycard token per exchange, because zone tokens are single use."""
    keycard = FakeMiddleware()

    provider = identity_token_provider(keycard)

    assert provider() == "zone-token-1"
    assert provider() == "zone-token-2"
    assert keycard.grants == [["https://api.anthropic.com"]] * 2
