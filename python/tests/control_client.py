"""Independent Python process used by the real File Host and offline package acceptance tests."""

import json
import sys

from atomic_harness import HarnessClient, TlsCredentials
from atomic_harness.config import ClientLimits

config = json.loads(sys.argv[1])
client = HarnessClient(config["origin"], tls=TlsCredentials(**config["tls"]), limits=ClientLimits(**config["limits"]))
print(json.dumps({"kind": "python-client-ready"}), flush=True)
try:
    for line in sys.stdin:
        command = json.loads(line)
        try:
            if command.get("kind") == "close":
                client.close()
                result = {"closed": True}
            elif command.get("kind") == "events":
                result = list(client.events(command["params"]))
            else:
                result = client.request(command["method"], command["params"])
            print(json.dumps({"id": command["id"], "result": result}), flush=True)
        except Exception as error:
            print(json.dumps({"id": command["id"], "error": {
                "name": type(error).__name__, "acceptance": getattr(error, "acceptance", None),
                "code": getattr(error, "code", None)}}), flush=True)
        if command.get("kind") == "close":
            break
finally:
    client.close()
