"""One cancellation token owns only callback registrations for its pending attempts."""

from collections.abc import Callable
from threading import Lock


class CancellationToken:
    """Cancel local requests from another thread; registrations are removed when each attempt settles."""

    def __init__(self) -> None:
        self._lock = Lock()
        self._cancelled = False
        self._callbacks: set[Callable[[], None]] = set()

    @property
    def cancelled(self) -> bool:
        """Whether cancel() has been requested."""
        with self._lock:
            return self._cancelled

    def cancel(self) -> None:
        """Interrupt every current registration once; accepted server work remains owned by the server."""
        with self._lock:
            if self._cancelled:
                return
            self._cancelled = True
            callbacks = tuple(self._callbacks)
            self._callbacks.clear()
        for callback in callbacks:
            callback()

    def _register(self, callback: Callable[[], None]) -> Callable[[], None]:
        with self._lock:
            cancelled = self._cancelled
            if not cancelled:
                self._callbacks.add(callback)
        if cancelled:
            callback()

        def unregister() -> None:
            with self._lock:
                self._callbacks.discard(callback)

        return unregister
