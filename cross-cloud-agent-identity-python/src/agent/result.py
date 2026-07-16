"""Structured result type for tool operations."""

from dataclasses import dataclass
from enum import Enum
import json


class Error(str, Enum):
    KEYCARD_DENIED = "KEYCARD_DENIED"
    KEYCARD_NOT_CONFIGURED = "KEYCARD_NOT_CONFIGURED"
    NO_TOKEN = "NO_TOKEN"
    VALIDATION = "VALIDATION"
    NETWORK = "NETWORK"
    SNOWFLAKE = "SNOWFLAKE"
    INSUFFICIENT_SCOPE = "INSUFFICIENT_SCOPE"
    NO_MATCHING_DATA = "NO_MATCHING_DATA"
    INTERNAL = "INTERNAL"


@dataclass
class Result:
    ok: bool
    data: str | None = None
    error: Error | None = None
    message: str | None = None
    details: dict | None = None

    @staticmethod
    def success(data: str) -> "Result":
        return Result(ok=True, data=data)

    @staticmethod
    def failure(error: Error, message: str, details: dict | None = None) -> "Result":
        return Result(ok=False, error=error, message=message, details=details)

    def to_json(self) -> str:
        d: dict = {"ok": self.ok}
        if self.ok:
            d["data"] = self.data
        else:
            d["error"] = self.error.value if self.error else None
            d["message"] = self.message
            if self.details:
                d["details"] = self.details
        return json.dumps(d)
