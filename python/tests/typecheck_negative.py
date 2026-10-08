"""This file must fail mypy: unknown method, mismatched parameters, result fields and union branch."""

from atomic_harness import HarnessClient
from atomic_harness.types import CanonicalUuid


def rejected_calls(client: HarnessClient, identity: CanonicalUuid) -> None:
    client.request("host.unknown", {})
    client.request("input.submit", {"expectedInstanceId": identity})
    result = client.request("input.submit", {"agentKey": "writer", "submissionKey": "task-1", "text": "Task"})
    _: int = result["inputEventId"]
    client.request("message.wait", {"agentKey": "writer", "messageId": identity,
                                    "direction": "outbox", "until": "disposed", "timeoutMs": 1000})
