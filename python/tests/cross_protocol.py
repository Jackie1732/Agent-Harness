"""Evaluate a TypeScript-produced corpus with the installed/generated Python codec."""

import json
import sys

from atomic_harness.codec import decode_params, decode_response
from atomic_harness.config import ClientLimits
from atomic_harness.errors import ProtocolError

limits = ClientLimits(1048576, 2097152, 64, 100000, 1000, 5000, 2)
cases = json.load(sys.stdin)
results = []
for case in cases:
    try:
        if case["kind"] == "params":
            decode_params(case["method"], case["value"], limits)
        else:
            decode_response(case["method"], case["value"], case["requestId"], case["status"])
        accepted = True
    except ProtocolError:
        accepted = False
    results.append({"label": case["label"], "accepted": accepted})
json.dump(results, sys.stdout)
