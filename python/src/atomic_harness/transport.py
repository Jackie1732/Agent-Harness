"""One bounded HTTP attempt owns its socket, cancellation reason and deadline timer."""

import http.client
import io
import select
import socket
import ssl
from threading import Lock, Timer
from time import monotonic

from .config import ClientLimits, _ConnectionConfig
from .errors import Acceptance, ClientAbortError, ClientTransportError
from .response_io import TlsResponseReader


class _TlsConnection(http.client.HTTPSConnection):
    def __init__(self, config: _ConnectionConfig, deadline: float, attempt: "Attempt") -> None:
        super().__init__(config.host, config.port, timeout=max(0.001, deadline - monotonic()), context=config.context)
        self._connect_deadline = deadline
        self._attempt = attempt
        self._server_name = config.server_name
        self._tls_context = config.context
        class Response(http.client.HTTPResponse):
            def __init__(self, sock: socket.socket, debuglevel: int = 0,
                         method: str | None = None, url: str | None = None) -> None:
                super().__init__(sock, debuglevel=debuglevel, method=method, url=url)
                assert self.fp is not None and isinstance(sock, ssl.SSLSocket)
                self.fp = io.BufferedReader(TlsResponseReader(sock, self.fp, attempt.check, attempt.wait))
        self.response_class = Response

    def connect(self) -> None:
        http.client.HTTPConnection.connect(self)
        assert self.sock is not None
        remaining = self._connect_deadline - monotonic()
        if remaining <= 0:
            raise TimeoutError("Connection deadline elapsed")
        self.sock.settimeout(remaining)
        self.sock = self._tls_context.wrap_socket(
            self.sock, server_hostname=self._server_name, do_handshake_on_connect=False)
        self.sock.setblocking(False)
        while True:
            self._attempt.check()
            try:
                self.sock.do_handshake()
                break
            except ssl.SSLWantReadError:
                self._attempt.wait(self.sock, False, self._connect_deadline)
            except ssl.SSLWantWriteError:
                self._attempt.wait(self.sock, True, self._connect_deadline)
        if monotonic() >= self._connect_deadline:
            raise TimeoutError("Connection deadline elapsed")


class Attempt:
    """The acceptance flag is conservative after authenticated TLS; cancellation is local only."""

    def __init__(self, read_only: bool, limits: ClientLimits) -> None:
        self.deadline = monotonic() + limits.request_timeout_ms / 1000
        self._read_only = read_only
        self._lock = Lock()
        self._connection: _TlsConnection | None = None
        self._reason: str | None = None
        self._sent = False
        self._done = False
        self._wake: tuple[socket.socket, socket.socket] | None = None
        self._timer = Timer(limits.request_timeout_ms / 1000, self.stop, args=("timeout",))
        self._timer.daemon = True

    @property
    def acceptance(self) -> Acceptance:
        with self._lock:
            return "not-applicable" if self._read_only else "unknown" if self._sent else "not-accepted"

    def start(self) -> None:
        """Start the complete-attempt deadline after the client registers ownership."""
        self._timer.start()

    def stop(self, reason: str = "aborted") -> None:
        """Interrupt the owned connection once; the first local stop reason wins."""
        with self._lock:
            if self._done or self._reason is not None:
                return
            self._reason = reason
            connection = self._connection
            wake = self._wake
            if wake is not None:
                wake[1].send(b"\0")
        if connection is not None and connection.sock is not None:
            try:
                connection.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                # A peer close or concurrent attempt settlement already released this socket.
                pass

    def check(self) -> None:
        """Report cancellation or expiry before sending or accepting a receipt."""
        with self._lock:
            reason = self._reason
        if reason == "aborted":
            raise ClientAbortError(self.acceptance)
        if reason == "timeout" or monotonic() >= self.deadline:
            raise ClientTransportError(self.acceptance)

    def wait(self, tls: ssl.SSLSocket, writing: bool, deadline: float | None = None) -> None:
        """Wait for TLS readiness or cancellation within the connection and total deadlines."""
        self.check()
        assert self._wake is not None
        receiver = self._wake[0]
        expires = self.deadline if deadline is None else min(deadline, self.deadline)
        select.select([receiver] if writing else [receiver, tls], [tls] if writing else [], [],
                      max(0, expires - monotonic()))
        self.check()
        if monotonic() >= expires:
            raise ClientTransportError(self.acceptance)

    def exchange(self, config: _ConnectionConfig, limits: ClientLimits,
                 path: str, body: bytes) -> tuple[int, str, bytes]:
        """Perform one authenticated POST without redirects, retries or connection reuse."""
        self.check()
        connect_deadline = min(monotonic() + limits.connect_timeout_ms / 1000, self.deadline)
        connection = _TlsConnection(config, connect_deadline, self)
        with self._lock:
            self._connection = connection
            self._wake = socket.socketpair()
        self.check()
        try:
            connection.connect()
            self.check()
            with self._lock:
                self._sent = True
            assert connection.sock is not None
            connection.sock.settimeout(max(0.001, self.deadline - monotonic()))
            connection.request("POST", path, body, headers={"content-type": "application/json", "connection": "close"})
            connection.sock.setblocking(False)
            response = connection.getresponse()
            try:
                data = response.read(limits.max_response_bytes + 1)
                self.check()
                if len(data) > limits.max_response_bytes or response.length not in (None, 0):
                    raise ClientTransportError(self.acceptance)
                return response.status, response.getheader("content-type", ""), data
            finally:
                response.close()
        except (OSError, http.client.HTTPException, ValueError):
            self.check()
            raise ClientTransportError(self.acceptance) from None

    def finish(self) -> None:
        """Release the timer and socket before the client removes this attempt from its registry."""
        with self._lock:
            self._done = True
            connection = self._connection
            wake = self._wake
        self._timer.cancel()
        self._timer.join()
        if connection is not None:
            connection.close()
        if wake is not None:
            for stream in wake:
                stream.close()
