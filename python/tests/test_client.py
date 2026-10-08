"""Real local mTLS transport failures and client-local resource ownership."""

import json
import socket
import ssl
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from atomic_harness import (
    ApiError,
    CancellationToken,
    ClientAbortError,
    ClientLimits,
    ClientTransportError,
    HarnessClient,
    ProtocolError,
    TlsCredentials,
    parse_session_event_id,
)
from atomic_harness.codec import CONTROL_PROTOCOL, CONTROL_VERSION, decode_params, encode_json

CERTS = Path(__file__).resolve().parents[2] / "tests" / "host" / "certs"
LIMITS = ClientLimits(1048576, 2097152, 64, 100000, 1000, 3000, 2)
TLS = TlsCredentials(CERTS / "ca.pem", CERTS / "client.pem", CERTS / "client-key.pem", "localhost")
SESSION = "91000000-0000-4000-8000-000000000002"
EVENT = "ah-event:" + SESSION + ":1"


def event(sequence):
    return {"envelopeVersion": 1, "sessionId": SESSION, "eventId": f"ah-event:{SESSION}:{sequence}",
            "sequence": sequence, "recordedAt": "2026-10-08T00:00:00.000Z", "type": "test/item",
            "payloadVersion": 1, "payload": {"sequence": sequence}}


def page(sequence=1, through=2):
    more = sequence < through
    return {"sessionId": SESSION, "through": through, "parent": None, "events": [event(sequence)], "hasMore": more,
            "nextCursor": {"sessionId": SESSION, "through": through, "nextSequence": sequence + 1} if more else None}


class _Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # The fault fixtures deliberately close a connection before its pending write completes.
        pass


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.release = threading.Event()
        self.received = threading.Event()
        self.handle = lambda request, handler: handler.reply(request, {
            "agentKey": "writer", "sessionId": SESSION, "inputEventId": EVENT, "reused": False})
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers["content-length"])))
                owner.calls.append(request)
                owner.received.set()
                owner.handle(request, self)

            def reply(self, request, result):
                self.write(200, {"protocol": CONTROL_PROTOCOL, "version": CONTROL_VERSION,
                                 "requestId": request["requestId"], "kind": "result", "result": result})

            def write(self, status, body, content_type="application/json"):
                data = json.dumps(body).encode() if not isinstance(body, bytes) else body
                self.send_response(status)
                self.send_header("content-type", content_type)
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = _Server(("127.0.0.1", 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(CERTS / "server.pem"), str(CERTS / "server-key.pem"))
        context.load_verify_locations(str(CERTS / "ca.pem"))
        context.verify_mode = ssl.CERT_REQUIRED
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        self.server_thread = threading.Thread(target=self.server.serve_forever,
                                              kwargs={"poll_interval": 0.02}, daemon=True)
        self.server_thread.start()
        self.client = self.make_client()

    def tearDown(self):
        self.release.set()
        self.client.close()
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join()

    def make_client(self, limits=LIMITS, tls=TLS):
        return HarnessClient(f"https://127.0.0.1:{self.server.server_port}", tls=tls, limits=limits)

    def submit(self, client=None, cancel=None):
        return (client or self.client).request("input.submit", {
            "agentKey": "writer", "submissionKey": "first", "text": "task"}, cancel=cancel)

    def assert_acceptance(self, exception, acceptance):
        self.assertEqual(exception.exception.acceptance, acceptance)

    def test_valid_receipt_and_local_preflight(self):
        self.assertEqual(self.submit()["inputEventId"], EVENT)
        with self.assertRaises(ProtocolError):
            self.client.request("input.submit", {"agentKey": "writer", "submissionKey": "missing-text"})
        self.assertEqual(len(self.calls), 1)

    def test_origin_limits_and_tls_identity_are_explicit(self):
        for origin in ["http://localhost", "https://user@localhost", "https://localhost/path", "https://localhost?q=1"]:
            with self.assertRaises(ValueError):
                HarnessClient(origin, tls=TLS, limits=LIMITS)
        for changes in [{"max_json_depth": 129}, {"request_timeout_ms": 2147483648}, {"max_connections": True}]:
            with self.assertRaises(ValueError):
                replace(LIMITS, **changes)
        with self.assertRaises(ValueError):
            self.make_client(tls=replace(TLS, server_name="127.0.0.1"))
        with self.make_client(tls=replace(TLS, server_name="invalid.test")) as client:
            with self.assertRaises(ClientTransportError) as failure:
                self.submit(client)
            self.assert_acceptance(failure, "not-accepted")
        self.assertEqual(len(self.calls), 0)

    def test_valid_server_rejection_and_wrong_http_status(self):
        def reject(request, handler, status=403):
            handler.write(status, {"protocol": CONTROL_PROTOCOL, "version": CONTROL_VERSION,
                                  "requestId": request["requestId"], "kind": "error", "error": {
                                      "code": "API_FORBIDDEN", "message": "Control request rejected",
                                      "acceptance": "not-accepted", "domainCode": None}})
        self.handle = reject
        with self.assertRaises(ApiError) as rejection:
            self.submit()
        self.assertEqual(rejection.exception.code, "API_FORBIDDEN")
        self.assert_acceptance(rejection, "not-accepted")
        self.handle = lambda request, handler: reject(request, handler, 200)
        with self.assertRaises(ClientTransportError) as uncertain:
            self.submit()
        self.assert_acceptance(uncertain, "unknown")
        self.assertEqual(len(self.calls), 2)

    def test_disconnected_mutation_is_unknown_without_retry(self):
        self.handle = lambda request, handler: handler.connection.shutdown(2)
        with self.assertRaises(ClientTransportError) as failure:
            self.submit()
        self.assert_acceptance(failure, "unknown")
        self.assertEqual(len(self.calls), 1)

    def test_truncated_content_length_rejects_complete_json_for_mutations_and_observations(self):
        for method, params, result, acceptance in [
            ("input.submit", {"agentKey": "writer", "submissionKey": "truncated", "text": "task"},
             {"agentKey": "writer", "sessionId": SESSION, "inputEventId": EVENT, "reused": False}, "unknown"),
            ("session.events", {"target": {"kind": "member", "agentKey": "writer"}, "maxEvents": 1},
             page(1, 1), "not-applicable"),
        ]:
            with self.subTest(method=method):
                def truncated(request, handler, result=result):
                    body = json.dumps({"protocol": CONTROL_PROTOCOL, "version": CONTROL_VERSION,
                                       "requestId": request["requestId"], "kind": "result", "result": result}).encode()
                    handler.send_response(200)
                    handler.send_header("content-type", "application/json")
                    handler.send_header("content-length", str(len(body) + 5))
                    handler.end_headers()
                    handler.wfile.write(body)
                    handler.close_connection = True

                self.handle = truncated
                with self.assertRaises(ClientTransportError) as failure:
                    self.client.request(method, params)
                self.assert_acceptance(failure, acceptance)
                self.assertEqual(len(self.client._attempts), 0)
        self.assertEqual(len(self.calls), 2)

    def test_complete_close_delimited_response_is_accepted(self):
        def close_delimited(request, handler):
            body = json.dumps({"protocol": CONTROL_PROTOCOL, "version": CONTROL_VERSION,
                               "requestId": request["requestId"], "kind": "result", "result": {
                                   "agentKey": "writer", "sessionId": SESSION,
                                   "inputEventId": EVENT, "reused": False}}).encode()
            handler.send_response(200)
            handler.send_header("content-type", "application/json")
            handler.end_headers()
            handler.wfile.write(body)
            handler.close_connection = True

        self.handle = close_delimited
        self.assertEqual(self.submit()["inputEventId"], EVENT)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(self.client._attempts), 0)

    def test_oversized_event_sequence_is_rejected_at_local_and_response_boundaries(self):
        oversized = "ah-event:" + SESSION + ":" + "9" * 5000
        with self.subTest(boundary="local"):
            maximum = "ah-event:" + SESSION + ":9007199254740991"
            self.assertEqual(parse_session_event_id(maximum), (SESSION, 9007199254740991))
            with self.assertRaises(ProtocolError):
                parse_session_event_id("ah-event:" + SESSION + ":9007199254740992")
            with self.assertRaises(ProtocolError):
                parse_session_event_id(oversized)
            with self.assertRaises(ProtocolError):
                decode_params("root.get", {"agentKey": "writer", "rootId": oversized}, LIMITS)
        invalid_page = page(1, 1)
        invalid_page["events"][0]["eventId"] = oversized
        for method, params, result, acceptance in [
            ("input.submit", {"agentKey": "writer", "submissionKey": "oversized", "text": "task"},
             {"agentKey": "writer", "sessionId": SESSION, "inputEventId": oversized, "reused": False}, "unknown"),
            ("session.events", {"target": {"kind": "member", "agentKey": "writer"}, "maxEvents": 1},
             invalid_page, "not-applicable"),
        ]:
            with self.subTest(method=method):
                self.handle = lambda request, handler, result=result: handler.reply(request, result)
                with self.assertRaises(ClientTransportError) as failure:
                    self.client.request(method, params)
                self.assert_acceptance(failure, acceptance)
                self.assertEqual(len(self.client._attempts), 0)
        self.assertEqual(len(self.calls), 2)

    def test_response_bytes_utf8_and_correlation_are_validated(self):
        cases = [(b"x" * 129, "application/json"), (b"\xff", "application/json"), (b"{}", "text/plain")]
        with self.make_client(limits=replace(LIMITS, max_response_bytes=128)) as client:
            for body, media_type in cases:
                self.handle = lambda request, handler, body=body, media_type=media_type: handler.write(
                    200, body, media_type)
                with self.assertRaises(ClientTransportError) as failure:
                    self.submit(client)
                self.assert_acceptance(failure, "unknown")
        self.handle = lambda request, handler: handler.reply({"requestId": "other"}, {})
        with self.assertRaises(ClientTransportError) as failure:
            self.client.request("host.status", {})
        self.assert_acceptance(failure, "not-applicable")

    def test_cancellation_before_and_after_transmission(self):
        cancelled = CancellationToken()
        cancelled.cancel()
        with self.assertRaises(ClientAbortError) as before:
            self.submit(cancel=cancelled)
        self.assert_acceptance(before, "not-accepted")
        self.assertEqual(len(self.calls), 0)
        self.handle = lambda request, handler: self.release.wait(3)
        cancel = CancellationToken()
        with ThreadPoolExecutor() as pool:
            call = pool.submit(self.submit, cancel=cancel)
            self.assertTrue(self.received.wait(2))
            cancel.cancel()
            with self.assertRaises(ClientAbortError) as after:
                call.result(timeout=2)
            self.assert_acceptance(after, "unknown")
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(cancel._callbacks), 0)

    def test_close_joins_active_and_queued_attempts_without_shutting_down_server(self):
        self.handle = lambda request, handler: self.release.wait(3)
        client = self.make_client(limits=replace(LIMITS, max_connections=1))
        with ThreadPoolExecutor(max_workers=4) as pool:
            active = pool.submit(self.submit, client)
            self.assertTrue(self.received.wait(2))
            queued = pool.submit(self.submit, client)
            deadline = time.monotonic() + 2
            while len(client._attempts) < 2 and time.monotonic() < deadline:
                time.sleep(0.005)
            self.assertEqual(len(client._attempts), 2)
            pool.submit(client.close).result(timeout=2)
            pool.submit(client.dispose).result(timeout=2)
            with self.assertRaises(ClientAbortError) as started:
                active.result(timeout=2)
            with self.assertRaises(ClientAbortError) as waiting:
                queued.result(timeout=2)
            self.assert_acceptance(started, "unknown")
            self.assert_acceptance(waiting, "not-accepted")
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(client._attempts), 0)
        with self.assertRaises(ClientAbortError) as later:
            self.submit(client)
        self.assert_acceptance(later, "not-accepted")
        self.release.set()
        self.handle = lambda request, handler: handler.reply(request, {
            "agentKey": "writer", "sessionId": SESSION, "inputEventId": EVENT, "reused": False})
        self.assertEqual(self.submit()["inputEventId"], EVENT)

    def test_complete_request_deadline_is_not_reset_by_response_chunks(self):
        def drip(request, handler):
            handler.send_response(200)
            handler.send_header("content-type", "application/json")
            handler.send_header("content-length", "100")
            handler.end_headers()
            for _ in range(10):
                handler.wfile.write(b" ")
                handler.wfile.flush()
                if self.release.wait(0.04):
                    break
        self.handle = drip
        with self.make_client(limits=replace(LIMITS, request_timeout_ms=120)) as client:
            start = time.monotonic()
            with self.assertRaises(ClientTransportError) as failure:
                self.submit(client)
            self.assert_acceptance(failure, "unknown")
            self.assertLess(time.monotonic() - start, 1)
            self.assertEqual(len(client._attempts), 0)

    def test_tcp_and_tls_share_one_connection_deadline(self):
        context = self.server.socket.context

        class HandshakeServer(_Server):
            def get_request(self):
                connection, address = super().get_request()
                try:
                    connection.settimeout(2)
                    connection.recv(1, socket.MSG_PEEK)
                    time.sleep(0.2)
                    return context.wrap_socket(connection, server_side=True), address
                except OSError:
                    connection.close()
                    raise

        server = HandshakeServer(("127.0.0.1", 0), self.server.RequestHandlerClass)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        thread.start()
        connect = socket.create_connection

        def delayed_tcp(*args, **kwargs):
            time.sleep(0.2)
            return connect(*args, **kwargs)

        try:
            limits = replace(LIMITS, connect_timeout_ms=300, request_timeout_ms=1500)
            with HarnessClient(f"https://127.0.0.1:{server.server_port}", tls=TLS, limits=limits) as client:
                with patch("socket.create_connection", delayed_tcp):
                    with self.assertRaises(ClientTransportError) as failure:
                        self.submit(client)
                self.assert_acceptance(failure, "not-accepted")
                self.assertEqual(len(client._attempts), 0)
            self.assertEqual(len(self.calls), 0)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_stalled_tls_handshake_obeys_cancel_close_and_deadlines(self):
        for mode in ("cancel", "close", "connect-deadline", "request-deadline"):
            with self.subTest(mode=mode), socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                listener.listen()
                hello, release = threading.Event(), threading.Event()

                def peer(listener, hello, release):
                    connection, _ = listener.accept()
                    with connection:
                        connection.settimeout(2)
                        connection.recv(1)
                        hello.set()
                        release.wait(3)

                thread = threading.Thread(target=peer, args=(listener, hello, release), daemon=True)
                thread.start()
                limits = replace(LIMITS, connect_timeout_ms=200 if mode == "connect-deadline" else 2000,
                                 request_timeout_ms=120 if mode == "request-deadline" else 3000)
                client = HarnessClient(f"https://127.0.0.1:{listener.getsockname()[1]}", tls=TLS, limits=limits)
                cancel = CancellationToken()
                try:
                    with ThreadPoolExecutor(max_workers=2) as pool:
                        call = pool.submit(self.submit, client, cancel)
                        self.assertTrue(hello.wait(2))
                        closing = None
                        if mode == "cancel":
                            cancel.cancel()
                        elif mode == "close":
                            closing = pool.submit(client.close)
                        error = ClientAbortError if mode in ("cancel", "close") else ClientTransportError
                        with self.assertRaises(error) as failure:
                            call.result(timeout=1)
                        self.assert_acceptance(failure, "not-accepted")
                        if closing is not None:
                            closing.result(timeout=1)
                    self.assertEqual(len(client._attempts), 0)
                    self.assertEqual(len(cancel._callbacks), 0)
                finally:
                    release.set()
                    client.close()
                    thread.join(3)
        self.assertEqual(len(self.calls), 0)

    def test_iterator_captures_target_and_budget_and_holds_no_connection_between_pages(self):
        self.handle = lambda request, handler: handler.reply(request, page(len(self.calls)))
        query = {"target": {"kind": "member", "agentKey": "writer"}, "maxEvents": 1}
        iterator = self.client.events(query)
        self.assertEqual(len(self.calls), 0)
        first = next(iterator)
        self.assertEqual(first["through"], 2)
        self.assertEqual(len(self.client._attempts), 0)
        query["target"]["agentKey"] = "reviewer"
        query["maxEvents"] = 10
        first["hasMore"] = False
        first["nextCursor"]["through"] = 100
        first["nextCursor"]["nextSequence"] = 100
        second = next(iterator)
        self.assertEqual(second["events"][0]["sequence"], 2)
        self.assertEqual(self.calls[1]["params"]["target"]["agentKey"], "writer")
        self.assertEqual(self.calls[1]["params"]["maxEvents"], 1)
        self.assertEqual(self.calls[1]["params"]["cursor"]["through"], 2)
        second["hasMore"] = True
        second["nextCursor"] = {"sessionId": SESSION, "through": 100, "nextSequence": 3}
        with self.assertRaises(StopIteration):
            next(iterator)

    def test_event_page_must_match_the_requested_cut_and_start(self):
        self.handle = lambda request, handler: handler.reply(request, page(1, 1))
        with self.assertRaises(ClientTransportError) as failure:
            self.client.request("session.events", {"target": {"kind": "member", "agentKey": "writer"}, "maxEvents": 1,
                                                   "cursor": {"sessionId": SESSION, "through": 0, "nextSequence": 1}})
        self.assert_acceptance(failure, "not-applicable")

    def test_bounded_json_and_embedded_message_preflight(self):
        for value in [float("nan"), {"invalid": object()}, {1: "key"}]:
            with self.assertRaises(ProtocolError):
                encode_json(value, LIMITS)
        cycle = []
        cycle.append(cycle)
        with self.assertRaises(ProtocolError):
            encode_json(cycle, LIMITS)
        for limits, value in [(replace(LIMITS, max_request_bytes=5), "abcdef"),
                              (replace(LIMITS, max_json_nodes=2), [1, 2]),
                              (replace(LIMITS, max_json_depth=1), [[1]])]:
            with self.assertRaises(ProtocolError) as failure:
                encode_json(value, limits)
            self.assertEqual(failure.exception.code, "API_LIMIT_EXCEEDED")
        params = {"agentKey": "writer", "peerKey": "reviewer", "type": "test/note", "payloadVersion": 1,
                  "payloadJson": "[[[1]]]"}
        with self.assertRaises(ProtocolError) as failure:
            decode_params("message.send", params, replace(LIMITS, max_json_depth=2))
        self.assertEqual(failure.exception.code, "API_LIMIT_EXCEEDED")


if __name__ == "__main__":
    unittest.main()
