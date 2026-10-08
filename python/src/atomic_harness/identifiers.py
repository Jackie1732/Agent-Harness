"""Canonical wire identities shared with the durable Session representation."""

import re

from .errors import ProtocolError
from .types import CanonicalUuid, SessionAddress, SessionEventId

UUID_PATTERN = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
EVENT_PATTERN = re.compile(r"ah-event:([0-9a-f-]{36}):([1-9][0-9]*)")


def parse_session_id(value: str) -> CanonicalUuid:
    """Require a lower-case UUID Session identity."""
    if UUID_PATTERN.fullmatch(value) is None:
        raise ProtocolError()
    return CanonicalUuid(value)


def parse_session_address(value: str) -> CanonicalUuid:
    """Return the Session identity named by one canonical address."""
    if not value.startswith("ah-session:"):
        raise ProtocolError()
    return parse_session_id(value.removeprefix("ah-session:"))


def parse_session_event_id(value: str) -> tuple[CanonicalUuid, int]:
    """Return the Session identity and positive safe sequence named by an EventId."""
    matched = EVENT_PATTERN.fullmatch(value)
    if matched is None:
        raise ProtocolError()
    identity, sequence_text = matched.groups()
    identity = parse_session_id(identity)
    if len(sequence_text) > 16:
        raise ProtocolError()
    sequence = int(sequence_text)
    if sequence > 9_007_199_254_740_991:
        raise ProtocolError()
    return identity, sequence


def format_session_address(identity: CanonicalUuid) -> SessionAddress:
    """Derive the logical address of a Session identity."""
    return SessionAddress("ah-session:" + identity)


def format_session_event_id(identity: CanonicalUuid, sequence: int) -> SessionEventId:
    """Create one EventId from a Session identity and a positive safe sequence."""
    if type(sequence) is not int or not 1 <= sequence <= 9_007_199_254_740_991:
        raise ProtocolError()
    return SessionEventId(f"ah-event:{identity}:{sequence}")
