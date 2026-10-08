"""Cancelable TLS reads retain the standard library's HTTP parser and response framing."""

import io
import ssl
from collections.abc import Callable
from typing import Any, BinaryIO


class TlsResponseReader(io.RawIOBase):
    """A response file owns its original socket-file reference until HTTPResponse closes it."""

    def __init__(self, tls: ssl.SSLSocket, original: BinaryIO,
                 check: Callable[[], None], wait: Callable[[ssl.SSLSocket, bool], None]) -> None:
        self._tls = tls
        self._original = original
        self._check = check
        self._wait = wait

    def readable(self) -> bool:
        return True

    def readinto(self, buffer: Any) -> int:
        # Python 3.11 has no standard typing.Buffer; RawIOBase supplies a writable byte buffer.
        view = memoryview(buffer).cast("B")
        while True:
            self._check()
            try:
                data = self._tls.recv(len(view))
                view[:len(data)] = data
                return len(data)
            except ssl.SSLWantReadError:
                self._wait(self._tls, False)
            except ssl.SSLWantWriteError:
                self._wait(self._tls, True)

    def close(self) -> None:
        self._original.close()
        super().close()
