import base64
import json
from pathlib import Path
import tempfile
import unittest

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from capture_vault import CaptureVault
from analyze_capture import analyze_session, build_report, json_fields, markdown, Pairs, read_records, load_private


def b64(raw):
    return base64.b64encode(raw).decode()


class AnalyzeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.public = self.root / "public.pem"
        self.public.write_bytes(self.private.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))

    def tearDown(self):
        self.tmp.cleanup()

    def test_portable_private_key_permissions(self):
        import os
        key = self.root / 'private.pem'
        key.write_bytes(self.private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        key.chmod(0o600)
        self.assertEqual(load_private(key).public_key().public_numbers(), self.private.public_key().public_numbers())
        if os.name != 'nt':
            key.chmod(0o644)
            with self.assertRaises(ValueError):
                load_private(key)

    def test_custom_observation_labels(self):
        labels = ('direct-bridge', 'sub2api-inbound', 'sub2api-outbound')
        for label in labels:
            self.session(label)
        report = build_report(self.root, self.private, labels=labels)
        self.assertEqual(report['required_labels'], list(labels))
        self.assertEqual(report['missing_labels_with_flows'], [])
        self.assertEqual(len(report['candidate_groups'][0]['pairs']), 3)
        with self.assertRaises(ValueError):
            build_report(self.root, self.private, labels=['secret/invalid'])

    def session(self, label, terminal=True, finished=True, changed=False):
        vault = CaptureVault(self.root, label, self.public)
        meta = {"header_fields_b64": [[b64(b"Authorization"), b64(b"Bearer SECRET_API_TOKEN")], [b64(b"X-Unknown"), b64(b"value-one")], [b64(b"X-Unknown"), b64(b"value-two" if changed else b"value-one")]], "trailer_fields_b64": [], "method": {"bytes_b64": b64(b"POST")}}
        body = json.dumps({"model": "gpt-6-astra", "input": [{"role": "user", "content": "USER_PROMPT_MUST_NOT_LEAK"}], "extra": "OTHER_SECRET_VALUE" if changed else "BODY_MUST_NOT_LEAK"}).encode()
        vault.write("request_headers", {"flow_id": "flow-secret-id", "request": meta})
        vault.write("request_complete", {"flow_id": "flow-secret-id", "request": meta, "body_b64": b64(body)})
        response = {"header_fields_b64": [], "trailer_fields_b64": []}
        vault.write("response_headers", {"flow_id": "flow-secret-id", "response": response})
        sse = b'data: {"type":"response.completed","response":{"model":"gpt-6-astra"}}\n\n'
        vault.write("response_chunk", {"flow_id": "flow-secret-id", "body_b64": b64(sse)})
        vault.write("response_complete", {"flow_id": "flow-secret-id", "response": response})
        if terminal:
            vault.write("flow_terminal", {"flow_id": "flow-secret-id", "reason": "http_complete"})
        if finished:
            vault.close()
        else:
            vault._output.close()
        return vault.directory

    def test_safe_three_way_comparison_and_duplicates(self):
        for label in ("bridge-inbound", "bridge-upstream", "official-outbound"):
            self.session(label, changed=label == "official-outbound")
        report = build_report(self.root, self.private)
        rendered = json.dumps(report) + markdown(report)
        for forbidden in ("SECRET_API_TOKEN", "USER_PROMPT_MUST_NOT_LEAK", "OTHER_SECRET_VALUE", "BODY_MUST_NOT_LEAK", "value-one", "value-two", "flow-secret-id"):
            self.assertNotIn(forbidden, rendered)
        self.assertIn("gpt-6-astra", rendered)
        self.assertEqual(report["missing_labels_with_flows"], [])
        self.assertTrue(all(s["integrity"]["capture_complete"] for s in report["sessions"]))
        self.assertFalse(report["comparison_complete"])
        self.assertEqual(len(report["candidate_groups"]), 1)
        self.assertEqual(len(report["candidate_groups"][0]["pairs"]), 3)
        headers = report["sessions"][0]["flows"][0]["request"]["metadata"]["headers"]
        self.assertEqual([h["name"] for h in headers], ["Authorization", "X-Unknown", "X-Unknown"])
        self.assertEqual(headers[2]["occurrence"], 2)

    def test_missing_label_and_incomplete_session(self):
        self.session("bridge-inbound", terminal=False, finished=False)
        report = build_report(self.root, self.private)
        self.assertEqual(report["status"], "missing_required_labels")
        integrity = report["sessions"][0]["integrity"]
        self.assertTrue(integrity["frame_integrity_valid"])
        self.assertFalse(integrity["capture_complete"])
        self.assertFalse(integrity["session_end_present"])
        self.assertFalse(integrity["flow_terminals_all_present"])

    def test_truncation_and_gcm_failure(self):
        directory = self.session("bridge-inbound")
        path = directory / "events.cap"
        original = path.read_bytes()
        path.write_bytes(original[:-1])
        _, finding = read_records(directory, self.private)
        self.assertIn("truncated_frame_payload", finding["issues"])
        changed = bytearray(original)
        changed[-1] ^= 1
        path.write_bytes(changed)
        _, finding = read_records(directory, self.private)
        self.assertIn("gcm_authentication_failed", finding["issues"])

    def test_orphan_session_is_not_silently_ignored(self):
        directory = self.session("bridge-inbound")
        (directory / "events.cap").unlink()
        report = build_report(self.root, self.private)
        self.assertEqual(len(report["sessions"]), 1)
        self.assertIn("capture_file_unreadable", report["sessions"][0]["integrity"]["issues"])

    def test_verify_only_skips_values_and_duplicate_json_keys_preserved(self):
        directory = self.session("official-outbound")
        report = analyze_session(directory, self.private, verify_only=True)
        self.assertNotIn("request", report["flows"][0])
        fields = json_fields(json.loads('{"same":1,"same":2}', object_pairs_hook=Pairs))
        self.assertEqual([f["path"] for f in fields], ["$", '$["same"]', '$["same"][duplicate=2]'])

    def test_compressed_request_and_noncompletion_model_is_not_shown(self):
        import gzip
        vault = CaptureVault(self.root, "official-outbound", self.public)
        body = gzip.compress(b'{"input":"compressed input remains private"}')
        meta = {"header_fields_b64": [[b64(b"Content-Encoding"), b64(b"gzip")]], "trailer_fields_b64": []}
        vault.write("request_complete", {"flow_id": "gzip", "request": meta, "body_b64": b64(body)})
        response = {"header_fields_b64": [], "trailer_fields_b64": []}
        vault.write("response_headers", {"flow_id": "gzip", "response": response})
        vault.write("response_chunk", {"flow_id": "gzip", "body_b64": b64(b'data: {"type":"response.created","response":{"model":"gpt-FAKE-EARLY"}}\n\n')})
        vault.write("flow_terminal", {"flow_id": "gzip", "reason": "http_complete"})
        vault.close()
        result = analyze_session(vault.directory, self.private)
        flow = result["flows"][0]
        self.assertIsNone(flow["request"]["body"]["decode_issue"])
        self.assertTrue(flow["request"]["body"]["json_fields"])
        self.assertEqual(flow["completed_models"], [])
        self.assertNotIn("gpt-FAKE-EARLY", json.dumps(result))
        self.assertNotIn("compressed input remains private", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
