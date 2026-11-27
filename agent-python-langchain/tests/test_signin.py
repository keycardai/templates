import sys
from unittest.mock import Mock
from urllib.parse import parse_qs, urlsplit

import pytest

from calendar_agent import signin


@pytest.mark.parametrize("public", [False, True])
def test_signin_binds_client_identity_before_code_exchange(monkeypatch, public):
    issuer = "https://zone.example"
    monkeypatch.setenv("KEYCARD_ZONE_URL", issuer)
    monkeypatch.setenv("KEYCARD_CLIENT_ID", "agent-client")
    monkeypatch.setenv("KEYCARD_CLIENT_SECRET", "test-secret")
    monkeypatch.setenv("KEYCARD_LOGIN_CLIENT_ID", "login-client")
    args = ["signin.py", "--serve", "--once"]
    if public:
        args.append("--as-login-app")
    monkeypatch.setattr(sys, "argv", args)

    client = Mock()
    client.endpoints.authorize = f"{issuer}/authorize"
    client.exchange_authorization_code.return_value.access_token = "test-token"
    constructor = Mock(return_value=client)
    monkeypatch.setattr(signin, "Client", constructor)
    write_token = Mock()
    monkeypatch.setattr(signin, "_write_subject_token", write_token)
    seen = {}

    def server_factory(address, handler_type):
        def serve():
            handler = object.__new__(handler_type)
            handler.send_response = Mock()
            handler.send_header = Mock()
            handler.end_headers = Mock()
            handler._html = Mock()
            handler.path = "/"
            handler.do_GET()
            location = handler.send_header.call_args.args[1]
            query = parse_qs(urlsplit(location).query)
            seen.update(query)
            handler.path = f"/callback?code=test-code&state={query['state'][0]}"
            handler.do_GET()

        return Mock(serve_forever=serve)

    monkeypatch.setattr(signin.http.server, "HTTPServer", server_factory)
    monkeypatch.setattr(signin.threading, "Thread", lambda target, daemon: Mock(start=target))
    signin.main()

    expected_id = "login-client" if public else "agent-client"
    assert constructor.call_args.kwargs["issuer"] == issuer
    assert constructor.call_args.kwargs["client_id"] == expected_id
    assert constructor.call_args.kwargs["client_secret"] == (None if public else "test-secret")
    assert seen["client_id"] == [expected_id]
    client.exchange_authorization_code.assert_called_once()
    assert set(client.exchange_authorization_code.call_args.kwargs) == {
        "code", "redirect_uri", "code_verifier",
    }
    write_token.assert_called_once_with("test-token")
