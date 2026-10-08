"""Caller-owned TLS files and explicit per-client resource limits."""

import ipaddress
import ssl
from dataclasses import dataclass, fields
from pathlib import Path
from urllib.parse import urlsplit


@dataclass(frozen=True)
class ClientLimits:
    """Connect covers TCP and TLS together; the complete-attempt timeout also includes queueing."""

    max_request_bytes: int
    max_response_bytes: int
    max_json_depth: int
    max_json_nodes: int
    connect_timeout_ms: int
    request_timeout_ms: int
    max_connections: int

    def __post_init__(self) -> None:
        for field in fields(self):
            value = getattr(self, field.name)
            maximum = 2_147_483_647 if field.name.endswith("_ms") else 9_007_199_254_740_991
            if type(value) is not int or not 1 <= value <= maximum:
                raise ValueError("Client limits must be positive integers")
        if self.max_json_depth > 128:
            raise ValueError("Client JSON depth exceeds protocol ceiling")


@dataclass(frozen=True)
class TlsCredentials:
    """Local PEM files are read only by SSL setup; server_name selects a DNS certificate identity."""

    ca_file: str | Path
    cert_file: str | Path
    key_file: str | Path
    server_name: str | None = None


@dataclass(frozen=True)
class _ConnectionConfig:
    host: str
    port: int
    server_name: str
    context: ssl.SSLContext


def resolve_connection(origin: str, tls: TlsCredentials) -> _ConnectionConfig:
    """Validate one HTTPS origin and load TLS material before any connection is made."""
    parsed = urlsplit(origin)
    if (parsed.scheme != "https" or parsed.hostname is None or parsed.username is not None
            or parsed.password is not None or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise ValueError("Client origin must be a HTTPS origin")
    server_name = tls.server_name or parsed.hostname
    if tls.server_name is not None:
        if not tls.server_name:
            raise ValueError("Explicit server_name must name a DNS certificate identity")
        try:
            ipaddress.ip_address(tls.server_name)
        except ValueError:
            pass
        else:
            raise ValueError("Explicit server_name must name a DNS certificate identity")
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_verify_locations(cafile=str(tls.ca_file))
    context.load_cert_chain(str(tls.cert_file), str(tls.key_file))
    return _ConnectionConfig(parsed.hostname, parsed.port or 443, server_name, context)
