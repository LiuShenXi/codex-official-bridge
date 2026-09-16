"""Offline only: temporary keys and synthetic traffic, never real credentials."""
import base64
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
from types import SimpleNamespace

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from capture_vault import CaptureVault, MAGIC, FRAME
from capture_addon import CaptureAddon, target


def decrypt(directory, private):
    header = json.loads((directory / "header.json").read_bytes())
    key = private.decrypt(base64.b64decode(header["wrapped_key_b64"]), padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=b"codex-capture-v1"))
    cipher = AESGCM(key)
    raw = (directory / "events.cap").read_bytes()
    if not raw.startswith(MAGIC):
        raise ValueError("bad magic")
    pos, expected, records = len(MAGIC), 0, []
    while pos < len(raw):
        if len(raw)-pos < FRAME.size:
            raise ValueError("truncated frame header")
        frame = raw[pos:pos+FRAME.size]
        seq, size = FRAME.unpack(frame)
        pos += FRAME.size
        if seq != expected or size < 16 or size > len(raw)-pos:
            raise ValueError("missing, truncated or invalid frame")
        nonce = base64.b64decode(header["nonce_prefix_b64"]) + struct.pack(">Q", seq)
        record = cipher.decrypt(nonce, raw[pos:pos+size], MAGIC + header["stream_id"].encode("ascii") + frame)
        records.append(json.loads(record))
        pos += size
        expected += 1
    return records


class VaultTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.pub = self.root / "public.pem"
        self.pub.write_bytes(self.private.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
        self.vault = CaptureVault(self.root, "test", self.pub)

    def tearDown(self):
        self.vault.close()
        self.tmp.cleanup()

    def test_roundtrip_and_no_plaintext(self):
        payload = {"headers": [["Authorization", "Bearer SYNTHETIC_SECRET_DO_NOT_LOG"]], "body": "synthetic body"}
        self.vault.write("request", payload, sync=True)
        self.vault.close()
        records = decrypt(self.vault.directory, self.private)
        self.assertEqual(records[1]["data"], payload)
        self.assertEqual(records[-1]["event"], "session_end")
        for path in self.vault.directory.iterdir():
            self.assertNotIn(b"SYNTHETIC_SECRET_DO_NOT_LOG", path.read_bytes())

    def test_tamper_and_truncation_rejected(self):
        self.vault.write("sample", {"text": "complete"})
        self.vault.close()
        path = self.vault.directory / "events.cap"
        original = path.read_bytes()
        path.write_bytes(original[:-1])
        with self.assertRaises(ValueError):
            decrypt(self.vault.directory, self.private)
        changed = bytearray(original)
        changed[-1] ^= 1
        path.write_bytes(changed)
        with self.assertRaises(InvalidTag):
            decrypt(self.vault.directory, self.private)

    def test_stream_is_transparent_and_preserves_duplicate_headers(self):
        headers = SimpleNamespace(fields=[(b"X-Unknown", b"first"), (b"X-Unknown", b"second"), (b"Authorization", b"Bearer synthetic")])
        req = SimpleNamespace(host="chatgpt.com", port=443, url="https://chatgpt.com/backend-api/codex/responses", data=SimpleNamespace(method=b"POST", http_version=b"HTTP/1.1"), headers=headers, trailers=None, raw_content=b"\x28\xb5\x2f\xfd\x00")
        resp = SimpleNamespace(status_code=200, stream=False, headers=headers, trailers=None, data=SimpleNamespace(status_code=200, http_version=b"HTTP/2.0"))
        flow = SimpleNamespace(id="flow1", request=req, response=resp, client_conn=None, server_conn=None, kill=lambda: None)
        addon = CaptureAddon(self.vault)
        addon.requestheaders(flow)
        addon.request(flow)
        addon.responseheaders(flow)
        chunks = [b"event: example\n", b"data: example\n\n", b""]
        for chunk in chunks:
            self.assertIs(resp.stream(chunk), chunk)
        addon.response(flow)
        addon.done()
        records = decrypt(self.vault.directory, self.private)
        request = next(r for r in records if r["event"] == "request_complete")["data"]
        self.assertEqual(base64.b64decode(request["body_b64"]), req.raw_content)
        self.assertEqual(request["request"]["header_fields_b64"], [[base64.b64encode(k).decode(), base64.b64encode(v).decode()] for k,v in headers.fields])
        captured = [base64.b64decode(r["data"]["body_b64"]) for r in records if r["event"] == "response_chunk"]
        self.assertEqual(captured, chunks)
        self.assertTrue(any(r["event"] == "flow_terminal" for r in records))

    def test_scope_and_interrupted_terminal(self):
        req = SimpleNamespace(host="chatgpt.com", port=443, url="https://chatgpt.com/backend-api/codex/responses", data=SimpleNamespace(), headers=SimpleNamespace(fields=[]), trailers=None)
        self.assertTrue(target(req))
        req.url = "https://chatgpt.com/backend-api/accounts"
        self.assertFalse(target(req))
        req.url = "https://chatgpt.com/backend-api/codex/responses"
        flow = SimpleNamespace(id="unfinished", request=req, client_conn=None, server_conn=None, kill=lambda: None)
        addon = CaptureAddon(self.vault)
        addon.requestheaders(flow)
        addon.done()
        records = decrypt(self.vault.directory, self.private)
        terminal = next(r for r in records if r["event"] == "flow_terminal")
        self.assertEqual(terminal["data"]["reason"], "capture_process_stopped_before_completion")

    def test_websocket_payload_and_error_terminal(self):
        req = SimpleNamespace(host="localhost", port=18879, url="http://localhost:18879/v1/responses", data=SimpleNamespace(), headers=SimpleNamespace(fields=[]), trailers=None, raw_content=b"")
        resp = SimpleNamespace(status_code=101, stream=False, headers=SimpleNamespace(fields=[(b"Upgrade", b"websocket")]), trailers=None, data=SimpleNamespace(status_code=101))
        ws = SimpleNamespace(messages=[SimpleNamespace(type=2, from_client=False, timestamp=123.0, content=bytes(range(256)), dropped=False, injected=False)], close_code=1000, close_reason="done", timestamp_end=124.0, closed_by_client=False)
        flow = SimpleNamespace(id="ws1", request=req, response=resp, websocket=ws, error=None, client_conn=None, server_conn=None, kill=lambda: None)
        addon = CaptureAddon(self.vault)
        addon.requestheaders(flow)
        addon.request(flow)
        addon.responseheaders(flow)
        addon.response(flow)
        self.assertIn(flow.id, addon.active)
        addon.websocket_start(flow)
        addon.websocket_message(flow)
        addon.websocket_end(flow)
        flow.id = "error1"
        addon.requestheaders(flow)
        flow.error = SimpleNamespace(msg="synthetic cancellation", timestamp=125.0)
        addon.error(flow)
        addon.done()
        records = decrypt(self.vault.directory, self.private)
        message = next(r for r in records if r["event"] == "websocket_message")["data"]
        self.assertEqual(base64.b64decode(message["content_b64"]), bytes(range(256)))
        terminals = [r["data"]["reason"] for r in records if r["event"] == "flow_terminal"]
        self.assertEqual(terminals, ["websocket_closed", "error_or_cancellation"])

    def test_target_boundaries(self):
        for host, port, path, expected in [
            ("chatgpt.com", 443, "/backend-api/codex/responses", True),
            ("chatgpt.com", 443, "/backend-api/codex-foreign", False),
            ("auth.openai.com", 443, "/selftest/ping", False),
            ("selftest.local", 9999, "/selftest/ping", True),
            ("127.0.0.1", 18879, "/v1/responses", True),
            ("localhost", 8879, "/v1/responses/compact", True),
            ("localhost", 8879, "/v1/models?client_version=1", True),
            ("localhost", 8879, "/healthz", False),
        ]:
            with self.subTest(host=host, path=path):
                self.assertEqual(target(SimpleNamespace(host=host, port=port, url=f"http://{host}:{port}{path}")), expected)


if __name__ == "__main__":
    unittest.main()
