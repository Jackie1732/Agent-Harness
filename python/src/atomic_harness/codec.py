"""Shared Schema validation and the existing Control v1 reference/receipt relationships."""

import hashlib
import json
import math
import re
from datetime import datetime
from importlib.resources import files
from typing import Any, cast

from jsonschema import Draft202012Validator, FormatChecker, ValidationError, validators

from .config import ClientLimits
from .errors import ProtocolError
from .identifiers import UUID_PATTERN, parse_session_address, parse_session_event_id
from .types import JsonValue

# jsonschema's vocabulary is heterogeneous JSON; Any is confined to its schema and validated DTO access.
_SCHEMAS: dict[str, Any] = json.loads(files(__package__).joinpath("control-schema.json").read_text("utf-8"))
CONTROL_PROTOCOL: str = _SCHEMAS["protocol"]
CONTROL_VERSION: int = _SCHEMAS["version"]
CONTROL_PATH: str = _SCHEMAS["path"]
CONTROL_METHODS: tuple[str, ...] = tuple(_SCHEMAS["methods"])
_FORMATS = FormatChecker()


def _uuid(value: object) -> bool:
    return isinstance(value, str) and UUID_PATTERN.fullmatch(value) is not None


def _event(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parse_session_event_id(value)
        return True
    except ProtocolError:
        return False


def _address(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parse_session_address(value)
        return True
    except ProtocolError:
        return False


def _timestamp(value: object) -> bool:
    if not isinstance(value, str) or re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value) is None:
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


for _name, _checker in (("canonical-uuid", _uuid), ("session-event-id", _event),
                        ("session-address", _address), ("iso-timestamp", _timestamp)):
    _FORMATS.checks(_name)(_checker)


def _utf8_limit(validator: Any, maximum: int, value: JsonValue, schema: dict[str, Any]) -> Any:
    if isinstance(value, str) and len(value.encode("utf-8")) > maximum:
        yield ValidationError("String exceeds UTF-8 budget")


# The library's extension factory has no typed signature; its resulting validators validate JSON Schema.
_Validator = validators.extend(Draft202012Validator, {"maxUtf8Bytes": _utf8_limit})  # type: ignore[no-untyped-call]
_PARAMS = {method: _Validator(schema, format_checker=_FORMATS) for method, schema in _SCHEMAS["params"].items()}
_RESULTS = {method: _Validator({**schema, "$defs": _SCHEMAS["definitions"]}, format_checker=_FORMATS)
            for method, schema in _SCHEMAS["results"].items()}
_ENVELOPES = {kind: _Validator(_SCHEMAS[kind + "Envelope"], format_checker=_FORMATS)
              for kind in ("request", "result", "error")}


def encode_json(value: object, limits: ClientLimits, *, response: bool = False) -> bytes:
    """Reject non-JSON values, cycles and byte/depth/node overflow before schema validation."""
    maximum = limits.max_response_bytes if response else limits.max_request_bytes
    stack: list[tuple[object, int, bool]] = [(value, 0, False)]
    active: set[int] = set()
    nodes = byte_count = 0
    while stack:
        item, depth, leaving = stack.pop()
        if leaving:
            active.remove(id(item))
            continue
        nodes += 1
        if depth > limits.max_json_depth or nodes > limits.max_json_nodes:
            raise ProtocolError("API_LIMIT_EXCEEDED")
        if item is None or type(item) in (str, bool, int, float):
            if isinstance(item, float) and not math.isfinite(item):
                raise ProtocolError()
            if isinstance(item, str) and len(item.encode("utf-8")) > maximum:
                raise ProtocolError("API_LIMIT_EXCEEDED")
            scalar = json.dumps(item, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            byte_count += len(scalar.encode("utf-8"))
        elif type(item) in (dict, list):
            if id(item) in active:
                raise ProtocolError()
            collection = cast(dict[str, object] | list[object], item)
            if len(collection) > limits.max_json_nodes:
                raise ProtocolError("API_LIMIT_EXCEEDED")
            active.add(id(item))
            stack.append((item, depth, True))
            byte_count += 2 + max(0, len(collection) - 1)
            if isinstance(collection, dict):
                for key, child in collection.items():
                    if type(key) is not str:
                        raise ProtocolError()
                    byte_count += len(json.dumps(key, ensure_ascii=False).encode("utf-8")) + 1
                    stack.append((child, depth + 1, False))
            else:
                stack.extend((child, depth + 1, False) for child in collection)
        else:
            raise ProtocolError()
        if byte_count > maximum:
            raise ProtocolError("API_LIMIT_EXCEEDED")
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")


def decode_json(data: bytes, limits: ClientLimits) -> JsonValue:
    """Decode strict UTF-8 and bounded JSON from a complete response body."""
    if len(data) > limits.max_response_bytes:
        raise ProtocolError("API_LIMIT_EXCEEDED")
    try:
        value: object = json.loads(data.decode("utf-8"))
        encode_json(value, limits, response=True)
    except (ValueError, UnicodeError, RecursionError) as error:
        if isinstance(error, ProtocolError):
            raise
        raise ProtocolError() from None
    return cast(JsonValue, value)


def decode_params(method: str, value: object, limits: ClientLimits) -> dict[str, Any]:
    """Copy and validate the selected method, including nested message JSON budgets."""
    if method not in _PARAMS:
        raise ProtocolError()
    captured: dict[str, Any] = json.loads(encode_json(value, limits))
    if not _PARAMS[method].is_valid(captured):
        raise ProtocolError()
    if method in ("message.send", "message.reply"):
        payload = captured["payloadJson"].encode("utf-8")
        if len(payload) > limits.max_request_bytes:
            raise ProtocolError("API_LIMIT_EXCEEDED")
        try:
            encode_json(json.loads(payload), limits)
        except (ValueError, RecursionError) as error:
            if isinstance(error, ProtocolError):
                raise
            raise ProtocolError() from None
    return captured


def _references(value: Any) -> None:
    if isinstance(value, list):
        for item in value:
            _references(item)
    elif isinstance(value, dict):
        if "cuts" in value:
            identities = [cut["sessionId"] for cut in value["cuts"]]
            if len(set(identities)) != len(identities):
                raise ProtocolError()
        if "envelopeVersion" in value and "eventId" in value:
            identity, sequence = parse_session_event_id(value["eventId"])
            if (identity != value["sessionId"] or sequence != value["sequence"]
                    or re.fullmatch(r"[a-z][a-z0-9]*(?:[./_-][a-z0-9]+)*", value["type"]) is None):
                raise ProtocolError()
        if "address" in value and "eventId" in value:
            if parse_session_address(value["address"]) != parse_session_event_id(value["eventId"])[0]:
                raise ProtocolError()
        for key, child in value.items():
            if key not in ("payload", "value"):
                _references(child)


def _result_relationships(method: str, result: dict[str, Any]) -> None:
    _references(result)
    if method in ("root.get", "root.wait"):
        root = result if method == "root.get" else result["observation"]
        final = root["final"]
        if (root["outcome"] == "completed") != (final is not None):
            raise ProtocolError()
        if final is not None:
            if (final["textOmitted"] and final["text"] is not None or not final["textOmitted"]
                    and (final["text"] is None or len(final["text"].encode("utf-8")) != final["textBytes"])):
                raise ProtocolError()
    if method == "input.get" and ((result["kind"] == "answer") != (result["wait"] is not None)):
        raise ProtocolError()
    if method == "workflow.artifact":
        data = result["text"].encode("utf-8")
        if len(data) != result["byteLength"] or hashlib.sha256(data).hexdigest() != result["sha256"]:
            raise ProtocolError()
    if method == "session.events":
        cursor, previous = result["nextCursor"], None
        if result["hasMore"] != (cursor is not None):
            raise ProtocolError()
        for event in result["events"]:
            if (event["sessionId"] != result["sessionId"] or event["sequence"] > result["through"]
                    or previous is not None and event["sequence"] != previous + 1):
                raise ProtocolError()
            previous = event["sequence"]
        if (result["hasMore"] and not result["events"] or not result["hasMore"]
                and previous is not None and previous != result["through"]):
            raise ProtocolError()
        if cursor is not None and (cursor["sessionId"] != result["sessionId"] or cursor["through"] != result["through"]
                or cursor["nextSequence"] > result["through"]
                or previous is not None and cursor["nextSequence"] != previous + 1):
            raise ProtocolError()


def decode_response(method: str, value: JsonValue, request_id: str, status: int) -> dict[str, Any]:
    """Validate correlation, HTTP/code agreement and the entire method-specific result."""
    if _ENVELOPES["error"].is_valid(value):
        error = cast(dict[str, Any], value)
        if (error["requestId"] != request_id and not (error["requestId"] is None
                and error["error"]["acceptance"] == "not-accepted")
                or _SCHEMAS["httpStatus"][error["error"]["code"]] != status):
            raise ProtocolError()
        return error
    if not _ENVELOPES["result"].is_valid(value):
        raise ProtocolError()
    response = cast(dict[str, Any], value)
    if response["requestId"] != request_id or status != 200 or not _RESULTS[method].is_valid(response["result"]):
        raise ProtocolError()
    _result_relationships(method, response["result"])
    return response


def check_requested_page(params: dict[str, Any], page: dict[str, Any]) -> None:
    """Require the returned event page to continue exactly the caller's captured prefix."""
    cursor = params.get("cursor")
    first = cursor["nextSequence"] if cursor is not None else params.get("after", 0) + 1
    if (cursor is not None and (page["sessionId"] != cursor["sessionId"] or page["through"] != cursor["through"])
            or page["through"] < first - 1 or len(page["events"]) > params["maxEvents"]
            or page["events"] and page["events"][0]["sequence"] != first
            or not page["events"] and first <= page["through"]):
        raise ProtocolError()
