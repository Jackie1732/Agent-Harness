"""Errors preserve whether a domain operation may already have been accepted."""

from typing import Literal, TypeAlias

Acceptance: TypeAlias = Literal["not-accepted", "unknown", "not-applicable"]


class ApiError(Exception):
    """A validated server rejection; domain_code does not choose the HTTP status."""

    def __init__(self, code: str, message: str, acceptance: Acceptance, domain_code: str | None) -> None:
        super().__init__(message)
        self.code = code
        self.acceptance = acceptance
        self.domain_code = domain_code


class ClientTransportError(Exception):
    """No valid receipt was obtained; the client never retries an uncertain modification."""

    def __init__(self, acceptance: Acceptance) -> None:
        super().__init__("Control transport failed")
        self.acceptance = acceptance


class ClientAbortError(Exception):
    """Cancellation stops this client's connection and observation, not accepted work."""

    def __init__(self, acceptance: Acceptance) -> None:
        super().__init__("Control request aborted")
        self.acceptance = acceptance


class ProtocolError(ValueError):
    """Local JSON/schema rejection exposes no submitted fields or credentials."""

    def __init__(self, code: str = "API_PROTOCOL_INVALID") -> None:
        super().__init__("Control data rejected")
        self.code = code
