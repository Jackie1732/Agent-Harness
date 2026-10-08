"""Synchronous Control v1 requests and a finite, demand-driven event iterator."""

import uuid
from collections.abc import Iterator
from threading import Condition
from time import monotonic
from types import TracebackType
from typing import Any

from .cancellation import CancellationToken
from .codec import (
    _SCHEMAS,
    CONTROL_PATH,
    CONTROL_PROTOCOL,
    CONTROL_VERSION,
    check_requested_page,
    decode_json,
    decode_params,
    decode_response,
    encode_json,
)
from .config import ClientLimits, TlsCredentials, resolve_connection
from .errors import ApiError, ClientAbortError, ClientTransportError, ProtocolError
from .transport import Attempt


class HarnessClient:
    """Own local request attempts only; construction authenticates no connection and executes no Host work."""

    def __init__(self, origin: str, *, tls: TlsCredentials, limits: ClientLimits) -> None:
        self._config = resolve_connection(origin, tls)
        self._limits = limits
        self._condition = Condition()
        self._attempts: set[Attempt] = set()
        self._connections = 0
        self._closed = False

    def request(self, method: str, params: object, *, cancel: CancellationToken | None = None) -> dict[str, Any]:
        """Perform one validated request; cancellation never issues a domain cancel or an automatic retry."""
        read_only = _SCHEMAS["categories"].get(method) == "observation"
        with self._condition:
            if self._closed or cancel is not None and cancel.cancelled:
                raise ClientAbortError("not-applicable" if read_only else "not-accepted")
        captured = decode_params(method, params, self._limits)
        request_id = str(uuid.uuid4())
        body = encode_json({"protocol": CONTROL_PROTOCOL, "version": CONTROL_VERSION,
                            "requestId": request_id, "method": method, "params": captured}, self._limits)
        attempt = Attempt(read_only, self._limits)
        leased = False

        def abort() -> None:
            attempt.stop()
            with self._condition:
                self._condition.notify_all()

        with self._condition:
            if self._closed:
                raise ClientAbortError(attempt.acceptance)
            self._attempts.add(attempt)
            attempt.start()
        unregister = cancel._register(abort) if cancel is not None else lambda: None
        try:
            with self._condition:
                while self._connections >= self._limits.max_connections:
                    attempt.check()
                    self._condition.wait(max(0.001, attempt.deadline - monotonic()))
                attempt.check()
                self._connections += 1
                leased = True
            status, content_type, data = attempt.exchange(self._config, self._limits, CONTROL_PATH, body)
            try:
                if content_type.split(";", 1)[0].strip().lower() != "application/json":
                    raise ProtocolError()
                receipt = decode_response(method, decode_json(data, self._limits), request_id, status)
                if receipt["kind"] == "error":
                    error = receipt["error"]
                    raise ApiError(error["code"], error["message"], error["acceptance"], error["domainCode"])
                result: dict[str, Any] = receipt["result"]
                if method == "session.events":
                    check_requested_page(captured, result)
                attempt.check()
                return result
            except (ProtocolError, UnicodeError, KeyError, TypeError):
                raise ClientTransportError(attempt.acceptance) from None
        finally:
            unregister()
            attempt.finish()
            with self._condition:
                self._attempts.remove(attempt)
                if leased:
                    self._connections -= 1
                self._condition.notify_all()

    def events(self, params: object, *, cancel: CancellationToken | None = None) -> Iterator[dict[str, Any]]:
        """Capture parameters on first advance and yield pages from exactly one fixed Session prefix."""
        query = decode_params("session.events", params, self._limits)
        while True:
            page = self.request("session.events", query, cancel=cancel)
            has_more = page["hasMore"]
            next_cursor = dict(page["nextCursor"]) if has_more else None
            yield page
            if not has_more:
                return
            query = {"target": query["target"], "maxEvents": query["maxEvents"], "cursor": next_cursor}

    def close(self) -> None:
        """Stop new requests, interrupt this client's attempts and join their resource release."""
        with self._condition:
            self._closed = True
            attempts = tuple(self._attempts)
        for attempt in attempts:
            attempt.stop()
        with self._condition:
            self._condition.notify_all()
            self._condition.wait_for(lambda: not self._attempts)

    dispose = close

    def __enter__(self) -> "HarnessClient":
        return self

    def __exit__(self, exc_type: type[BaseException] | None, exc_value: BaseException | None,
                 traceback: TracebackType | None) -> None:
        self.close()
