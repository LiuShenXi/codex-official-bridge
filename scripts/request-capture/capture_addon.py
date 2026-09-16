"""mitmproxy 11 application-layer capture; full values go only into CaptureVault.

This does not record TLS records, HTTP/2 frames, TCP segments, websocket wire
frames, or original transfer-chunk boundaries. TLS interception itself changes
the TLS peer. Header fields are the parser's ordered byte fields, including
duplicates, not a claim about unparsed wire formatting. Requests are buffered
by mitmproxy; responses are streamed and the callback returns bytes unchanged.
"""
from __future__ import annotations

import importlib.util
import asyncio
import json
import os
from pathlib import Path
import time
from urllib.parse import urlsplit

_spec = importlib.util.spec_from_file_location("codex_capture_vault", Path(__file__).with_name("capture_vault.py"))
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
CaptureVault, b64 = _module.CaptureVault, _module.b64


def value(v):
    if isinstance(v, (bytes, bytearray, memoryview)):
        return {"bytes_b64": b64(v)}
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    if isinstance(v, (tuple, list)):
        return [value(i) for i in v]
    if isinstance(v, dict):
        return {str(k): value(i) for k, i in v.items()}
    if hasattr(v, "to_pem"):
        return {"certificate_pem_b64": b64(v.to_pem())}
    return {"type": type(v).__name__, "representation": str(v)}


def fields(headers):
    return [] if headers is None else [[b64(k), b64(v)] for k, v in headers.fields]


def connection(conn):
    if conn is None:
        return None
    names = ("id", "address", "peername", "sockname", "transport_protocol", "state", "error",
             "timestamp_start", "timestamp_end", "timestamp_tcp_setup", "timestamp_tls_setup",
             "tls", "tls_established", "tls_version", "sni", "alpn", "alpn_offers", "cipher",
             "cipher_list", "certificate_list", "proxy_mode", "via")
    return {name: value(getattr(conn, name)) for name in names if hasattr(conn, name)}


def message_meta(message):
    data = message.data
    result = {"header_fields_b64": fields(message.headers),
              "trailer_fields_b64": fields(getattr(message, "trailers", None)),
              "timestamp_start": getattr(message, "timestamp_start", None),
              "timestamp_end": getattr(message, "timestamp_end", None)}
    for name in ("http_version", "method", "scheme", "authority", "host", "port", "path", "status_code", "reason"):
        if hasattr(data, name):
            result[name] = value(getattr(data, name))
    if hasattr(message, "url"):
        result["url"] = message.url
    return result


def target(request):
    host = request.host.lower().rstrip(".")
    path = urlsplit(request.url).path
    if host == "chatgpt.com":
        return path == "/backend-api/codex" or path.startswith("/backend-api/codex/")
    if host in ("127.0.0.1", "localhost", "::1", "selftest.local"):
        if path == "/selftest" or path.startswith("/selftest/") or path == "/__capture_selftest__" or path.startswith("/__capture_selftest__/"):
            return True
        return host != "selftest.local" and path in ("/v1/responses", "/v1/responses/compact", "/v1/models", "/v1/images/generations")
    return False


class CaptureAddon:
    def __init__(self, vault=None):
        self.vault = vault
        self.active = {}
        self.failed = False
        self.events_written = 0
        self.flows_completed = 0
        self.watch_task = None

    def load(self, loader):
        if self.vault is None:
            self.vault = CaptureVault(os.environ["CAPTURE_ROOT"], os.environ["CAPTURE_LABEL"], os.environ["CAPTURE_PUBLIC_KEY"])

    def running(self):
        from mitmproxy import ctx
        # Fail startup if another addon would retain unencrypted complete flows.
        if getattr(ctx.options, "save_stream_file", None):
            raise RuntimeError("Built-in flow saving must be disabled for capture")
        quiet = {}
        if hasattr(ctx.options, "flow_detail"):
            quiet["flow_detail"] = 0
        if hasattr(ctx.options, "termlog_verbosity"):
            quiet["termlog_verbosity"] = "error"
        if quiet:
            ctx.options.update(**quiet)
        if os.environ.get("CAPTURE_STATUS_FILE") or os.environ.get("CAPTURE_STOP_FILE"):
            self.write_status(True)
            self.watch_task = asyncio.create_task(self.watch_control())

    def write_status(self, ready):
        dest = os.environ.get("CAPTURE_STATUS_FILE")
        if not dest:
            return
        path = Path(dest)
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps({"ready": ready, "failed": self.failed,
            "active_flows": len(self.active), "events_written": self.events_written,
            "flows_completed": self.flows_completed, "pid": os.getpid(),
            "label": os.environ.get("CAPTURE_LABEL"), "updated_ns": time.time_ns()}), encoding="utf-8")
        os.replace(temp, path)

    async def watch_control(self):
        from mitmproxy import ctx
        stop = os.environ.get("CAPTURE_STOP_FILE")
        while True:
            self.write_status(not self.failed)
            if stop and Path(stop).exists():
                ctx.master.shutdown()
                return
            await asyncio.sleep(0.5)

    def emit(self, event, flow=None, extra=None, sync=False):
        data = {} if extra is None else dict(extra)
        if flow is not None:
            data.update(flow_id=flow.id, client_connection=connection(flow.client_conn), server_connection=connection(flow.server_conn))
        try:
            result = self.vault.write(event, data, sync=sync)
            self.events_written += 1
            return result
        except Exception:
            self.failed = True
            if flow is not None:
                try:
                    flow.kill()
                except Exception:
                    pass
            # Never include original exception: it may contain an upstream value.
            raise RuntimeError("Encrypted capture storage failed; target flow stopped") from None

    def requestheaders(self, flow):
        if not target(flow.request):
            return
        if self.failed:
            flow.kill()
            return
        self.active[flow.id] = {"flow": flow, "chunks": 0, "bytes": 0, "stream_eof": False, "websocket": False}
        self.emit("request_headers", flow, {"request": message_meta(flow.request),
                  "capture_semantics": {"request_body": "buffered_by_mitmproxy", "headers": "parsed_ordered_byte_fields_with_duplicates",
                      "response_chunks": "HTTP_entity_stream_callback_chunks_not_TCP_or_transfer_frames"}}, sync=True)

    def request(self, flow):
        if flow.id not in self.active:
            return
        body = flow.request.raw_content
        self.emit("request_complete", flow, {"request": message_meta(flow.request), "body_b64": b64(body),
                  "body_available": body is not None, "body_length": None if body is None else len(body)}, sync=True)

    def responseheaders(self, flow):
        if flow.id not in self.active:
            return
        state = self.active[flow.id]
        is_upgrade = flow.response.status_code == 101
        state["websocket"] = is_upgrade
        self.emit("response_headers", flow, {"response": message_meta(flow.response), "upgrade_101": is_upgrade}, sync=True)
        if is_upgrade:
            return
        if flow.response.stream:
            self.emit("capture_error", flow, {"reason": "preexisting_response_stream_transform"}, sync=True)
            flow.kill()
            self.terminal(flow, "capture_conflict")
            return

        def stream(chunk):
            # Capture before forwarding, preserving bytes and never joining chunks.
            state["chunks"] += 1
            state["bytes"] += len(chunk)
            self.emit("response_chunk", flow, {"chunk_index": state["chunks"] - 1, "body_b64": b64(chunk), "length": len(chunk)})
            if not chunk:
                state["stream_eof"] = True
                self.emit("response_stream_eof", flow, {"chunks": state["chunks"], "bytes": state["bytes"]}, sync=True)
            return chunk
        flow.response.stream = stream

    def response(self, flow):
        if flow.id not in self.active:
            return
        state = self.active[flow.id]
        self.emit("response_complete", flow, {"response": message_meta(flow.response), "chunks": state["chunks"],
                  "bytes": state["bytes"], "stream_eof_seen": state["stream_eof"]}, sync=True)
        if not state["websocket"]:
            self.terminal(flow, "http_complete")

    def websocket_start(self, flow):
        if flow.id not in self.active:
            return
        self.active[flow.id]["websocket"] = True
        self.emit("websocket_start", flow, {"payload_semantics": "parsed_reassembled_decompressed_message_payload_not_original_wire_frames",
                  "not_available": ["wire_fragmentation", "mask_key", "RSV_bits", "compressed_wire_bytes", "ping_pong_control_frames"]}, sync=True)

    def websocket_message(self, flow):
        if flow.id not in self.active:
            return
        msg = flow.websocket.messages[-1]
        self.emit("websocket_message", flow, {"message_index": len(flow.websocket.messages)-1,
                  "type": int(msg.type), "from_client": msg.from_client, "timestamp": msg.timestamp,
                  "content_b64": b64(msg.content), "length": len(msg.content),
                  "dropped": getattr(msg, "dropped", None), "injected": getattr(msg, "injected", None)})

    def websocket_end(self, flow):
        if flow.id not in self.active:
            return
        ws = flow.websocket
        metadata = {name: value(getattr(ws, name, None)) for name in ("closed_by_client", "close_code", "close_reason", "timestamp_end")}
        metadata["error"] = value(getattr(getattr(flow, "error", None), "msg", None))
        self.emit("websocket_end", flow, metadata, sync=True)
        self.terminal(flow, "websocket_closed")

    def client_disconnected(self, client):
        for state in list(self.active.values()):
            flow = state["flow"]
            if getattr(flow.client_conn, "id", None) == client.id:
                self.emit("client_disconnected", flow, {"connection": connection(client)}, sync=True)
                self.terminal(flow, "client_connection_closed_before_flow_terminal")

    def server_disconnected(self, data):
        for state in list(self.active.values()):
            flow = state["flow"]
            if getattr(flow.server_conn, "id", None) == data.server.id:
                # A normal EOF may still be followed by buffered HTTP response events.
                self.emit("server_disconnected", flow, {"connection": connection(data.server)}, sync=True)

    def error(self, flow):
        if flow.id not in self.active:
            return
        self.emit("http_error", flow, {"error": value(getattr(flow.error, "msg", str(flow.error))),
                  "timestamp": getattr(flow.error, "timestamp", None)}, sync=True)
        self.terminal(flow, "error_or_cancellation")

    def terminal(self, flow, reason):
        state = self.active.pop(flow.id, None)
        if state is not None:
            self.flows_completed += 1
            self.emit("flow_terminal", flow, {"reason": reason, "chunks": state["chunks"], "bytes": state["bytes"],
                      "stream_eof_seen": state["stream_eof"], "websocket": state["websocket"]}, sync=True)

    def done(self):
        if self.vault is None:
            return
        for state in list(self.active.values()):
            self.terminal(state["flow"], "capture_process_stopped_before_completion")
        self.vault.close({"capture_failed": self.failed})
        if self.watch_task:
            self.watch_task.cancel()
        self.write_status(False)


addons = [CaptureAddon()]
