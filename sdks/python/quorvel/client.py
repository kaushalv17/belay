"""Minimal Quorvel API client mirroring the TS SDK surface (Phase 5 skeleton).

This is intentionally small and dependency-light. Expand with retries,
idempotency keys, and typed events to reach parity with the TS SDK.
"""
from __future__ import annotations

import os
from typing import Any, Optional

import httpx


class QuorvelError(Exception):
    def __init__(self, message: str, status: int, code: Optional[str] = None):
        super().__init__(message)
        self.status = status
        self.code = code


class Quorvel:
    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: str = "https://api.quorvel.tech",
        timeout: float = 15.0,
    ):
        self.api_key = api_key or os.environ.get("QUORVEL_API_KEY")
        if not self.api_key:
            raise ValueError("api_key is required (or set QUORVEL_API_KEY)")
        self.base_url = base_url.rstrip("/")
        self._client = httpx.Client(timeout=timeout)

    def _request(self, method: str, path: str, json: Any = None) -> Any:
        resp = self._client.request(
            method,
            f"{self.base_url}{path}",
            headers={"authorization": f"Bearer {self.api_key}"},
            json=json,
        )
        if resp.status_code >= 400:
            code = None
            message = f"request failed: {resp.status_code}"
            try:
                data = resp.json()
                message = data.get("error", message)
                code = data.get("code")
            except Exception:
                pass
            raise QuorvelError(message, resp.status_code, code)
        if resp.status_code == 204:
            return None
        return resp.json()

    def usage(self) -> Any:
        return self._request("GET", "/v1/usage")

    def list_recent(self, limit: int = 50) -> Any:
        return self._request("GET", f"/v1/actions?limit={limit}")

    def track(self, idempotency_key: str, tool: str, scope: str = "default",
              args: Optional[dict] = None, cost: int = 1) -> Any:
        return self._request("POST", "/v1/actions", {
            "idempotencyKey": idempotency_key,
            "tool": tool,
            "scope": scope,
            "args": args or {},
            "cost": cost,
        })
