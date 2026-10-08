"""Examples prove that method selection fixes each result type and discriminated request fields."""

from typing import assert_type

from atomic_harness import HarnessClient, format_session_event_id, parse_session_id
from atomic_harness.types import CanonicalUuid, InputSubmitResult, SessionEventId, SessionEventsResult


def typed_calls(client: HarnessClient, instance: CanonicalUuid, root: SessionEventId) -> None:
    receipt = client.request("input.submit", {"agentKey": "writer", "submissionKey": "task-1", "text": "Research task"})
    assert_type(receipt, InputSubmitResult)
    assert_type(receipt["inputEventId"], SessionEventId)
    client.request("host.run", {"expectedInstanceId": instance})
    external_root = format_session_event_id(parse_session_id("91000000-0000-4000-8000-000000000002"), 1)
    client.request("root.get", {"agentKey": "writer", "rootId": external_root})
    client.request("root.wait", {"agentKey": "writer", "rootId": root, "timeoutMs": 1000})
    client.request("message.wait", {"agentKey": "writer", "messageId": instance,
                                    "direction": "outbox", "until": "terminal", "timeoutMs": 1000})
    for page in client.events({"target": {"kind": "member", "agentKey": "writer"}, "maxEvents": 10}):
        assert_type(page, SessionEventsResult)
