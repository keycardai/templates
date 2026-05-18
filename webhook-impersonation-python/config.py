"""Runtime configuration loaded once from the environment.

`load_dotenv` runs at import time so any module can simply
`from config import settings` without worrying about import order.
"""

import os
from dataclasses import dataclass
from functools import lru_cache

from dotenv import find_dotenv, load_dotenv

load_dotenv(find_dotenv(usecwd=True))

SERVER_NAME = "webhook-impersonation-python"


@dataclass(frozen=True)
class Settings:
    keycard_url: str
    keycard_client_id: str
    keycard_client_secret: str
    webhook_secret: str
    linear_mcp_url: str
    port: int


def _require(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"{name} is required. Set it in .env or run via `keycard run -- uvicorn main:app`."
        )
    return value


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings(
        keycard_url=_require("KEYCARD_URL"),
        keycard_client_id=os.environ.get("KEYCARD_CLIENT_ID", ""),
        keycard_client_secret=os.environ.get("KEYCARD_CLIENT_SECRET", ""),
        webhook_secret=os.environ.get("WEBHOOK_SECRET", ""),
        linear_mcp_url=os.environ.get("IMPERSONATION_RESOURCE", "https://mcp.linear.app/mcp"),
        port=int(os.environ.get("PORT", "8000")),
    )


settings = get_settings()
