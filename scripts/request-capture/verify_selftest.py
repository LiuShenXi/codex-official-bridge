"""Verify synthetic encrypted captures in memory; emit only safe check summaries.

An open capture session is reported separately from complete HTTP/WS flows.
No decrypted payload or private key is written to disk or included in errors.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
from pathlib import Path
import struct
import sys
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from capture_vault import FRAME, MAGIC, MAX_FRAME_BYTES
from keys import dpapi

MOCK_SECRET = b"SELFTEST_ONLY_NEVER_PLAIN"


def decode(value):
    return base64.b64decode(value, validate=True)


def read_stream(directory, private_key):
    envelope_bytes = (directory / "header.json").read_bytes()
    envelope = json.loads(envelope_bytes)
    if envelope["format"] != "codex-capture-v1" or envelope["cipher"] != "AES-256-GCM":
        raise ValueError("unsupported_capture_format")
    der = private_key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    if hashlib.sha256(der).hexdigest() != envelope["public_key_sha256"]:
        raise ValueError("capture_key_mismatch")
    key = private_key.decrypt(
        decode(envelope["wrapped_key_b64"]),
        padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=b"codex-capture-v1"),
    )
    cipher = AESGCM(key)
    prefix = decode(envelope["nonce_prefix_b64"])
    if len(prefix) != 4:
        raise ValueError("invalid_nonce_prefix")
    raw = (directory / "events.cap").read_bytes()
    if not raw.startswith(MAGIC):
        raise ValueError("invalid_magic")
    secret_absent = MOCK_SECRET not in raw and MOCK_SECRET not in envelope_bytes
    offset, records = len(MAGIC), []
    while offset < len(raw):
        if len(raw) - offset < FRAME.size:
            raise ValueError("truncated_frame_header")
        frame = raw[offset:offset + FRAME.size]
        sequence, size = FRAME.unpack(frame)
        offset += FRAME.size
        if sequence != len(records) or size < 16 or size > MAX_FRAME_BYTES:
            raise ValueError("invalid_frame_header")
        if len(raw) - offset < size:
            raise ValueError("truncated_ciphertext")
        aad = MAGIC + envelope["stream_id"].encode("ascii") + frame
        plaintext = cipher.decrypt(prefix + struct.pack(">Q", sequence), raw[offset:offset + size], aad)
        record = json.loads(plaintext)
        if record["sequence"] != sequence or record["schema"] != 1:
            raise ValueError("invalid_record_sequence")
        records.append(record)
        offset += size
    if not records or records[0]["event"] != "session_start":
        raise ValueError("missing_session_start")
    ends = [i for i, item in enumerate(records) if item["event"] == "session_end"]
    if ends and ends != [len(records) - 1]:
        raise ValueError("invalid_session_end")
    return records, secret_absent, bool(ends)


def header_values(message, name):
    return [decode(v) for k, v in message["header_fields_b64"] if decode(k).lower() == name.lower()]


def event(flow, name):
    matches = [item["data"] for item in flow if item["event"] == name]
    if len(matches) != 1:
        raise ValueError("event_count_mismatch")
    return matches[0]


def verify(root, expected_path, key_path):
    expected = json.loads(expected_path.read_text(encoding="utf-8"))
    private_key = serialization.load_pem_private_key(dpapi(key_path.read_bytes(), True), password=None)
    streams = [root] if (root / "header.json").is_file() else sorted(p.parent for p in root.glob("*/header.json"))
    if not streams:
        raise ValueError("no_capture_streams")
    records, secret_absent, ended = [], True, 0
    for stream in streams:
        items, absent, complete = read_stream(stream, private_key)
        records.extend(items)
        secret_absent = secret_absent and absent
        ended += complete
    flows = {}
    for record in records:
        flow_id = (record.get("data") or {}).get("flow_id")
        if flow_id is not None:
            flows.setdefault(flow_id, []).append(record)
    candidates = {"/selftest/sse": [], "/selftest/ws": []}
    for flow in flows.values():
        headers = [item for item in flow if item["event"] == "request_headers"]
        if len(headers) != 1:
            continue
        path = urlsplit(headers[0]["data"]["request"]["url"]).path
        if path in candidates:
            candidates[path].append(flow)
    if not all(candidates.values()):
        raise ValueError("missing_synthetic_flow")
    # Fresh runs supersede earlier attempts in a reused capture directory.
    sse = max(candidates["/selftest/sse"], key=lambda flow: flow[0]["wall_time_ns"])
    ws = max(candidates["/selftest/ws"], key=lambda flow: flow[0]["wall_time_ns"])
    request = event(sse, "request_complete")
    response = event(sse, "response_headers")
    request_early = event(sse, "request_headers")
    chunks = [item["data"] for item in sse if item["event"] == "response_chunk"]
    response_complete = event(sse, "response_complete")
    sse_terminal = event(sse, "flow_terminal")
    ws_response = event(ws, "response_headers")
    ws_messages = [item["data"] for item in ws if item["event"] == "websocket_message"]
    ws_end = event(ws, "websocket_end")
    ws_terminal = event(ws, "flow_terminal")
    expected_request = decode(expected["request_body_b64"])
    expected_response = decode(expected["response_body_b64"])
    expected_ws = decode(expected["ws_payload_b64"])
    checks = {
        "encrypted_frames_authenticate": True,
        "mock_secret_absent_from_ciphertext_and_envelope": secret_absent,
        "request_duplicate_unknown_headers": all(
            header_values(item["request"], b"x-unknown-protocol") == [b"first", b"second"]
            for item in (request_early, request)
        ),
        "response_duplicate_unknown_headers": header_values(response["response"], b"x-unknown-response") == [b"first", b"second"],
        "mock_authorization_preserved": header_values(request["request"], b"authorization") == [b"Bearer " + MOCK_SECRET],
        "gzip_content_encoding_preserved": header_values(request["request"], b"content-encoding") == [b"gzip"],
        "exact_compressed_request_body": request["body_available"] and decode(request["body_b64"]) == expected_request,
        "request_body_length": request["body_length"] == len(expected_request),
        "stream_chunk_indices_and_lengths": bool(chunks) and all(
            item["chunk_index"] == i and item["length"] == len(decode(item["body_b64"]))
            for i, item in enumerate(chunks)
        ),
        "exact_streamed_response_body": b"".join(decode(item["body_b64"]) for item in chunks) == expected_response,
        "response_stream_eof": response_complete["stream_eof_seen"] and any(item["event"] == "response_stream_eof" for item in sse),
        "response_stream_totals": response_complete["chunks"] == len(chunks) and response_complete["bytes"] == len(expected_response),
        "http_flow_terminal": sse_terminal["reason"] == "http_complete",
        "websocket_handshake_and_start": ws_response["response"]["status_code"] == 101 and any(item["event"] == "websocket_start" for item in ws),
        "websocket_client_payload": [decode(item["content_b64"]) for item in ws_messages if item["from_client"]] == [expected_ws],
        "websocket_server_payload": [decode(item["content_b64"]) for item in ws_messages if not item["from_client"]] == [expected_ws],
        "websocket_message_lengths": all(item["length"] == len(decode(item["content_b64"])) for item in ws_messages),
        "websocket_close": ws_end["close_code"] == 1000 and ws_end["error"] is None,
        "websocket_flow_terminal": ws_terminal["reason"] == "websocket_closed",
        "no_selected_flow_capture_errors": not any(item["event"] in ("capture_error", "http_error") for item in sse + ws),
    }
    return {
        "passed": all(checks.values()),
        "checks": checks,
        "streams": len(streams),
        "closed_sessions": ended,
        "open_or_unclean_sessions": len(streams) - ended,
        "verified_synthetic_flows": 2,
        "response_callback_chunks": len(chunks),
        "scope": "application_layer_synthetic_HTTP_SSE_WebSocket",
        "session_note": "Missing session_end is open or unclean, never proof of full session completeness.",
    }


def main():
    base = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=base / "private/selftest-records")
    parser.add_argument("--expected", type=Path, default=base / "selftest-state/expected.json")
    parser.add_argument("--key", type=Path, default=base / "private/capture-private.dpapi")
    args = parser.parse_args()
    try:
        result = verify(args.root, args.expected, args.key)
    except Exception as exc:
        # Exception messages can include externally controlled content; omit them.
        result = {"passed": False, "failure_type": type(exc).__name__, "error": "verification_failed_without_plaintext_output"}
    print(json.dumps(result, sort_keys=True))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
