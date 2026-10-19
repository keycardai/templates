"""HMAC-SHA256 webhook signing — shared by the server and the CLI client.

Wire format for the `X-Signature` header is `sha256=<hex>`.
"""

import hashlib
import hmac

SCHEME = "sha256"


def sign(secret: str, body: bytes) -> str:
    """Return the `sha256=<hex>` header value for *body*."""
    digest = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return f"{SCHEME}={digest}"


def verify(secret: str, body: bytes, signature_header: str | None) -> bool:
    """Constant-time verification of an `X-Signature` header value."""
    if not signature_header or not secret:
        return False
    algo, _, provided_hex = signature_header.strip().partition("=")
    if algo.lower() != SCHEME or not provided_hex:
        return False
    expected_hex = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected_hex, provided_hex)
