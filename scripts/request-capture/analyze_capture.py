"""Read encrypted application captures in memory and write value-safe reports.

No decrypted request, token, cookie, header value, or body scalar is written.
Header names and JSON property paths remain visible for field-level comparison.
Only a recognized model name on response.completed may be shown as a value.
"""
from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
from pathlib import Path
import re
import struct
import sys
import zlib

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from capture_vault import MAGIC, FRAME, MAX_FRAME_BYTES

LABELS = ("bridge-inbound", "bridge-upstream", "official-outbound")
TERMINALS = {"http_complete", "websocket_closed", "error_or_cancellation", "capture_conflict",
             "capture_process_stopped_before_completion", "client_connection_closed_before_flow_terminal"}
MODEL = re.compile(r"(?:gpt-|codex-|chatgpt-|o[1-9])[-a-zA-Z0-9._:/]{0,120}\Z")


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def signature(raw):
    return {"sha256": sha(raw), "byte_length": len(raw)}


def binary(encoded):
    if not isinstance(encoded, str):
        raise ValueError("invalid_binary_field")
    return base64.b64decode(encoded, validate=True)


def safe_name(raw):
    text = raw if isinstance(raw, str) else raw.decode("ascii", "backslashreplace")
    # JSON map keys are usually schema names, but a value can also be used as a key.
    if (len(text) > 160 or re.search(r"sk-[A-Za-z0-9_-]{8,}|Bearer\s|eyJ[A-Za-z0-9_-]{10,}\.", text)
            or any(ord(c) < 32 or ord(c) == 127 for c in text)):
        return "[name-sha256:" + sha(text.encode("utf-8")) + "]"
    return text


class Pairs(list):
    """A JSON object retaining duplicate keys and their original order."""


def normalized(value):
    if isinstance(value, Pairs):
        return {"$ordered_object": [[k, normalized(v)] for k, v in value]}
    if isinstance(value, list):
        return [normalized(v) for v in value]
    return value


def canonical(value):
    return json.dumps(normalized(value), ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def json_fields(value, path="$", result=None):
    result = [] if result is None else result
    kind = ("object" if isinstance(value, Pairs) else "array" if isinstance(value, list) else
            "null" if value is None else "boolean" if isinstance(value, bool) else
            "string" if isinstance(value, str) else "number")
    item = {"path": path, "type": kind, **signature(canonical(value))}
    if isinstance(value, (str, list)):
        item["length"] = len(value)
    result.append(item)
    if isinstance(value, Pairs):
        occurrences = {}
        for key, child in value:
            occurrences[key] = occurrences.get(key, 0) + 1
            childpath = path + "[" + json.dumps(safe_name(key), ensure_ascii=False) + "]"
            if occurrences[key] > 1:
                childpath += "[duplicate=" + str(occurrences[key]) + "]"
            json_fields(child, childpath, result)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            json_fields(child, path + "[" + str(index) + "]", result)
    return result


def safe_headers(encoded):
    result, occurrences = [], {}
    for index, pair in enumerate(encoded):
        if not isinstance(pair, list) or len(pair) != 2:
            raise ValueError("invalid_header_pair")
        name, raw = binary(pair[0]), binary(pair[1])
        key = name.lower()
        occurrences[key] = occurrences.get(key, 0) + 1
        result.append({"index": index, "name": safe_name(name), "name_sha256": sha(name),
                       "occurrence": occurrences[key], "value": signature(raw)})
    return result


def header_value(meta, wanted):
    return b", ".join(binary(v) for k, v in meta.get("header_fields_b64", []) if binary(k).lower() == wanted)


def decode_body(raw, meta):
    encodings = [x.strip().lower() for x in header_value(meta, b"content-encoding").decode("ascii").split(",") if x.strip()]
    try:
        for encoding in reversed(encodings):
            if encoding == "gzip":
                raw = gzip.decompress(raw)
            elif encoding == "deflate":
                try:
                    raw = zlib.decompress(raw)
                except zlib.error:
                    raw = zlib.decompress(raw, -zlib.MAX_WBITS)
            elif encoding == "br":
                import brotli
                raw = brotli.decompress(raw)
            elif encoding == "zstd":
                import zstandard
                import io
                with zstandard.ZstdDecompressor().stream_reader(io.BytesIO(raw)) as stream:
                    raw = stream.read()
            elif encoding != "identity":
                return None, "unsupported_content_encoding"
    except ImportError:
        return None, "decoder_dependency_missing"
    except Exception:
        return None, "body_decode_failed"
    return raw, None


def prompt_hash(obj):
    if not isinstance(obj, dict):
        return None
    if isinstance(obj.get("response"), dict):
        obj = obj["response"]
    content = obj.get("input")
    if isinstance(content, str):
        return sha(json.dumps(content, ensure_ascii=False).encode())
    if isinstance(content, list):
        users = [x.get("content") for x in content if isinstance(x, dict) and x.get("role") == "user"]
        if users:
            return sha(json.dumps(users[-1], ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode())
    return None


def completed_models(raw, transport):
    candidates = []
    if transport == "sse":
        blocks = re.split(br"\r?\n\r?\n", raw)
        for block in blocks:
            lines = [line[5:].lstrip(b" ") for line in block.splitlines() if line.startswith(b"data:")]
            if lines:
                candidates.append(b"\n".join(lines))
    else:
        candidates.append(raw)
    models = []
    for candidate in candidates:
        try:
            event = json.loads(candidate)
        except (ValueError, UnicodeError):
            continue
        if not isinstance(event, dict) or event.get("type") != "response.completed":
            continue
        response = event.get("response")
        model = response.get("model") if isinstance(response, dict) else None
        item = {"source": transport + ":response.completed", "model_present": isinstance(model, str)}
        if isinstance(model, str):
            item["model"] = model if MODEL.fullmatch(model) else "[unrecognized-model-redacted]"
            item["model_value"] = signature(model.encode())
        models.append(item)
    return models


def load_private(path):
    # Portable PEM keys must be owner-only; Windows retains DPAPI support.
    path = Path(path)
    protected = path.read_bytes()
    if protected.startswith(b"-----BEGIN PRIVATE KEY-----"):
        import os
        if os.name != "nt" and (path.stat().st_mode & 0o077 or path.stat().st_uid != os.getuid()):
            raise ValueError("private_key_requires_owner_only_permissions")
        return serialization.load_pem_private_key(protected, password=None)
    import keys
    return serialization.load_pem_private_key(keys.dpapi(protected, True), password=None)


def read_records(directory, private):
    """Return authenticated prefix plus explicit integrity findings; never error text."""
    findings = {"frame_integrity_valid": False, "issues": [], "authenticated_records": 0}
    records = []
    try:
        header = json.loads((directory / "header.json").read_bytes())
        stream_id = header["stream_id"]
        if not re.fullmatch("[a-f0-9]{32}", stream_id) or header.get("format") != "codex-capture-v1":
            raise ValueError("invalid_envelope")
        prefix = binary(header["nonce_prefix_b64"])
        if len(prefix) != 4:
            raise ValueError("invalid_envelope")
        key = private.decrypt(binary(header["wrapped_key_b64"]), padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=b"codex-capture-v1"))
        cipher = AESGCM(key)
    except Exception:
        findings["issues"].append("envelope_or_key_invalid")
        return records, findings
    try:
        with (directory / "events.cap").open("rb") as source:
            total = (directory / "events.cap").stat().st_size
            if source.read(len(MAGIC)) != MAGIC:
                findings["issues"].append("invalid_magic")
                return records, findings
            expected = 0
            while True:
                frame = source.read(FRAME.size)
                if not frame:
                    findings["frame_integrity_valid"] = True
                    break
                if len(frame) != FRAME.size:
                    findings["issues"].append("truncated_frame_header")
                    break
                seq, size = FRAME.unpack(frame)
                if seq != expected:
                    findings["issues"].append("sequence_gap_or_reorder")
                    break
                if size < 16 or size > MAX_FRAME_BYTES:
                    findings["issues"].append("invalid_frame_length")
                    break
                if size > total-source.tell():
                    findings["issues"].append("truncated_frame_payload")
                    break
                ciphertext = source.read(size)
                try:
                    plain = cipher.decrypt(prefix + struct.pack(">Q", seq), ciphertext, MAGIC + stream_id.encode("ascii") + frame)
                except InvalidTag:
                    findings["issues"].append("gcm_authentication_failed")
                    break
                try:
                    record = json.loads(plain)
                    if not isinstance(record, dict) or record.get("sequence") != seq:
                        raise ValueError()
                    if record.get("data") is None:
                        record["data"] = {}
                    if not isinstance(record["data"], dict):
                        raise ValueError()
                except Exception:
                    findings["issues"].append("authenticated_record_invalid")
                    break
                records.append(record)
                expected += 1
    except OSError:
        findings["issues"].append("capture_file_unreadable")
    findings["authenticated_records"] = len(records)
    return records, findings


def safe_meta(meta):
    result = {"headers": safe_headers(meta.get("header_fields_b64", [])), "trailers": safe_headers(meta.get("trailer_fields_b64", []))}
    for key, item in meta.items():
        if key in ("header_fields_b64", "trailer_fields_b64"):
            continue
        if key in ("timestamp_start", "timestamp_end") and (item is None or isinstance(item, (int, float))):
            result[key] = item
        else:
            raw = binary(item["bytes_b64"]) if isinstance(item, dict) and "bytes_b64" in item else json.dumps(item, ensure_ascii=False, separators=(",", ":")).encode()
            result[safe_name(key)] = signature(raw)
    return result


def analyze_flow(records, verify_only):
    first = records[0]
    result = {"flow_ref": "flow_" + sha(str(first["data"].get("flow_id")).encode())[:16],
              "first_wall_time_ns": first.get("wall_time_ns"), "event_count": len(records),
              "terminal_present": False, "terminal_reason": None, "completed_models": [], "issues": []}
    for record in records:
        if record["event"] == "flow_terminal":
            result["terminal_present"] = True
            reason = record["data"].get("reason")
            result["terminal_reason"] = reason if reason in TERMINALS else "other_hashed_reason"
    if not result["terminal_present"]:
        result["issues"].append("missing_flow_terminal")
    if verify_only:
        return result
    response_chunks, response_meta = [], {}
    result.update(request=None, response=None, websocket_messages=[], connections=[], correlation_key=None)
    try:
        for record in records:
            event, data = record["event"], record["data"]
            if event == "request_headers" and result["request"] is None:
                result["request"] = {"metadata": safe_meta(data["request"]), "body": None}
            elif event == "request_complete":
                meta = data["request"]
                result["request"] = {"metadata": safe_meta(meta), "body": None}
                if data.get("body_b64") is not None:
                    raw = binary(data["body_b64"])
                    body = {"raw": signature(raw), "json_fields": []}
                    decoded, error = decode_body(raw, meta)
                    body["decode_issue"] = error
                    if decoded is not None:
                        body["decoded"] = signature(decoded)
                        try:
                            body["json_fields"] = json_fields(json.loads(decoded, object_pairs_hook=Pairs))
                            result["correlation_key"] = prompt_hash(json.loads(decoded))
                        except (ValueError, UnicodeError):
                            body["json_issue"] = "not_valid_json"
                    result["request"]["body"] = body
            elif event == "response_headers":
                response_meta = data["response"]
                result["response"] = {"metadata": safe_meta(response_meta)}
            elif event == "response_chunk":
                response_chunks.append(binary(data["body_b64"]))
            elif event == "response_complete":
                response_meta = data["response"]
                result["response"] = {"metadata": safe_meta(response_meta)}
            elif event == "websocket_message":
                raw = binary(data["content_b64"])
                message = {"index": data.get("message_index"), "from_client": data.get("from_client"), "type": data.get("type"),
                           "timestamp": data.get("timestamp"), "payload": signature(raw)}
                if data.get("from_client"):
                    try:
                        message["json_fields"] = json_fields(json.loads(raw, object_pairs_hook=Pairs))
                        correlation = prompt_hash(json.loads(raw))
                        message["correlation_key"] = correlation
                        if correlation:
                            result["correlation_key"] = result["correlation_key"] or correlation
                    except (ValueError, UnicodeError):
                        message["json_issue"] = "not_valid_json"
                else:
                    result["completed_models"].extend(completed_models(raw, "websocket"))
                result["websocket_messages"].append(message)
            # Keep connection metadata useful for comparison without publishing IPs or identifiers.
            if event in ("request_headers", "response_headers", "flow_terminal"):
                result["connections"].append({"event": event, "client": json_fields(json.loads(json.dumps(data.get("client_connection")), object_pairs_hook=Pairs)),
                                               "server": json_fields(json.loads(json.dumps(data.get("server_connection")), object_pairs_hook=Pairs))})
        if result["response"] is not None:
            raw = b"".join(response_chunks)
            result["response"]["stream"] = {"raw": signature(raw), "chunk_lengths": [len(x) for x in response_chunks]}
            decoded, error = decode_body(raw, response_meta)
            result["response"]["stream"]["decode_issue"] = error
            if decoded is not None:
                result["completed_models"].extend(completed_models(decoded, "sse"))
    except Exception:
        result["issues"].append("flow_record_decode_failed")
    return result


def analyze_session(directory, private, verify_only=False, labels=LABELS):
    records, integrity = read_records(directory, private)
    starts = [r for r in records if r["event"] == "session_start"]
    ends = [r for r in records if r["event"] == "session_end"]
    original_label = starts[0]["data"].get("label") if starts else None
    label = original_label if original_label in labels else "other_" + sha(str(original_label).encode())[:12]
    integrity["session_start_present"] = bool(starts)
    integrity["session_end_present"] = bool(ends)
    if not starts:
        integrity["issues"].append("missing_session_start")
    if not ends:
        integrity["issues"].append("missing_session_end_live_or_interrupted")
    if ends and records[-1]["event"] != "session_end":
        integrity["issues"].append("events_after_session_end")
    if len(starts) > 1 or len(ends) > 1:
        integrity["issues"].append("duplicate_session_boundary")
    if any(r["data"].get("capture_failed") for r in ends):
        integrity["issues"].append("capture_writer_reported_failure")
    by_flow = {}
    for record in records:
        flow_id = record["data"].get("flow_id")
        if flow_id is not None:
            by_flow.setdefault(str(flow_id), []).append(record)
    flows = [analyze_flow(items, verify_only) for items in by_flow.values()]
    integrity["flow_terminals_all_present"] = all(f["terminal_present"] for f in flows)
    integrity["capture_complete"] = not integrity["issues"] and integrity["frame_integrity_valid"] and integrity["flow_terminals_all_present"]
    return {"session_ref": "session_" + sha(directory.name.encode())[:16], "label": label, "integrity": integrity, "flows": flows}


def ordered_diff(left, right):
    result = []
    for index in range(max(len(left), len(right))):
        a, b = left[index] if index < len(left) else None, right[index] if index < len(right) else None
        if a != b:
            result.append({"index": index, "left": a, "right": b})
    return result


def field_diff(left, right):
    a, b = {i["path"]: i for i in left}, {i["path"]: i for i in right}
    return [{"path": path, "left": a.get(path), "right": b.get(path)} for path in sorted(a.keys() | b.keys()) if a.get(path) != b.get(path)]


def compare_pair(a, b, a_label, b_label):
    ar, br = a.get("request") or {}, b.get("request") or {}
    ab, bb = ar.get("body") or {}, br.get("body") or {}
    def effective_body(flow, body):
        if body.get("json_fields"):
            return body, "http_body"
        for message in flow.get("websocket_messages", []):
            if message.get("from_client") and message.get("json_fields"):
                return {"raw": message["payload"], "json_fields": message["json_fields"]}, "first_client_websocket_message"
        return body, "unavailable"
    ab, at = effective_body(a, ab)
    bb, bt = effective_body(b, bb)
    def metadata_diff(left, right):
        return [{"field": field, "left": left.get(field), "right": right.get(field)}
                for field in sorted(left.keys() | right.keys())
                if field not in ("headers", "trailers") and left.get(field) != right.get(field)]
    return {"left_label": a_label, "right_label": b_label, "left_flow": a["flow_ref"], "right_flow": b["flow_ref"],
            "request_payload_sources": {a_label: at, b_label: bt},
            "request_metadata_diff": metadata_diff(ar.get("metadata", {}), br.get("metadata", {})),
            "request_headers_ordered_diff": ordered_diff(ar.get("metadata", {}).get("headers", []), br.get("metadata", {}).get("headers", [])),
            "request_body_raw_equal": ab.get("raw") == bb.get("raw") if ab.get("raw") and bb.get("raw") else None,
            "request_json_field_diff": field_diff(ab.get("json_fields", []), bb.get("json_fields", [])),
            "response_headers_ordered_diff": ordered_diff((a.get("response") or {}).get("metadata", {}).get("headers", []), (b.get("response") or {}).get("metadata", {}).get("headers", [])),
            "response_metadata_diff": metadata_diff((a.get("response") or {}).get("metadata", {}), (b.get("response") or {}).get("metadata", {})),
            "websocket_message_payload_ordered_diff": ordered_diff([{k: v for k, v in m.items() if k != "json_fields"} for m in a.get("websocket_messages", [])],
                                                                   [{k: v for k, v in m.items() if k != "json_fields"} for m in b.get("websocket_messages", [])]),
            "completed_models": {a_label: a.get("completed_models", []), b_label: b.get("completed_models", [])}}


def build_report(root, private, verify_only=False, labels=LABELS):
    if not labels or len(set(labels)) != len(labels) or any(not re.fullmatch(r"[a-z0-9-]{1,64}", label) for label in labels):
        raise ValueError("invalid_capture_labels")
    root = Path(root).resolve()
    candidates = list(root.rglob("header.json")) + list(root.rglob("events.cap"))
    directories = sorted({p.parent for p in candidates if p.resolve().is_relative_to(root)})
    sessions = [analyze_session(path, private, verify_only, labels) for path in directories]
    present = {s["label"] for s in sessions if s["flows"]}
    missing = [label for label in labels if label not in present]
    report = {"schema": 1, "mode": "verify_only" if verify_only else "safe_field_comparison", "sessions": sessions,
              "required_labels": list(labels), "missing_labels_with_flows": missing,
              "comparison_complete": False, "candidate_groups": [],
              "notes": ["All header values and body scalar values are hashes and lengths, never plaintext.",
                        "Header order is parsed field order; websocket payloads are parsed messages, not original network frames.",
                        "Candidates use identical last-user-input hash then chronological occurrence; this is not proof of causal pairing.",
                        "A reused websocket may contain many requests: automatic pairing uses its first correlated request; all message field hashes remain available.",
                        "Live sessions without session_end are incomplete snapshots, not automatically corrupt."]}
    if not directories:
        report["status"] = "no_capture_files"
        return report
    if verify_only:
        report["status"] = "verified_integrity_only_comparison_not_performed"
        return report
    groups = {}
    for session in sessions:
        if session["label"] not in labels:
            continue
        for flow in session["flows"]:
            key = flow.get("correlation_key")
            if key:
                groups.setdefault(key, {}).setdefault(session["label"], []).append(flow)
    for key, sides in sorted(groups.items()):
        for side in sides.values():
            side.sort(key=lambda f: f.get("first_wall_time_ns") or 0)
        for ordinal in range(max(map(len, sides.values()))):
            chosen = {label: items[ordinal] for label, items in sides.items() if ordinal < len(items)}
            group = {"prompt_sha256": key, "occurrence": ordinal, "labels": sorted(chosen),
                     "missing_labels": [label for label in labels if label not in chosen], "pairing_verified": False, "pairs": []}
            from itertools import combinations
            for left, right in combinations(labels, 2):
                if left in chosen and right in chosen:
                    group["pairs"].append(compare_pair(chosen[left], chosen[right], left, right))
            report["candidate_groups"].append(group)
    decode_incomplete = any("flow_record_decode_failed" in f.get("issues", []) or
                            ((f.get("request") or {}).get("body") or {}).get("decode_issue") or
                            (((f.get("response") or {}).get("stream") or {}).get("decode_issue"))
                            for s in sessions for f in s["flows"])
    report["status"] = ("missing_required_labels" if missing else "capture_incomplete" if any(not s["integrity"]["capture_complete"] for s in sessions)
                        else "field_decode_incomplete" if decode_incomplete
                        else "no_shared_prompt_candidates" if not report["candidate_groups"] else "candidate_comparison_ready_pairing_review_required")
    return report


def markdown(report):
    lines = ["# Codex 请求采集安全分析", "", "状态：`" + report["status"] + "`。", "", "**完整比较尚未确认**：需要三条链路均有完整记录，并核对候选请求属于同一轮。", ""]
    if report["missing_labels_with_flows"]:
        lines += ["缺少有请求记录的链路：" + ", ".join(report["missing_labels_with_flows"]) + "。", ""]
    lines += ["| 链路 | 会话 | 请求数 | 加密帧完整 | session_end | 所有请求有终态 |", "|---|---|---:|---|---|---|"]
    for session in report["sessions"]:
        i = session["integrity"]
        lines.append(f"| {session['label']} | {session['session_ref']} | {len(session['flows'])} | {i['frame_integrity_valid']} | {i['session_end_present']} | {i['flow_terminals_all_present']} |")
        if i["issues"]:
            lines += ["", "该会话问题：`" + "`, `".join(i["issues"]) + "`。", ""]
    lines += ["", "## 候选逐字段比较", "", "下列配对按相同末条用户输入哈希和时间顺序生成，需要结合发送轮次确认。完整字段明细见同名 JSON。", ""]
    for index, group in enumerate(report["candidate_groups"], 1):
        lines.append(f"- 候选 {index}：出现序号 {group['occurrence']}；缺少链路：{', '.join(group['missing_labels']) or '无'}。")
        for pair in group["pairs"]:
            lines.append(f"  - {pair['left_label']} → {pair['right_label']}：请求头有序差异 {len(pair['request_headers_ordered_diff'])} 项；JSON 字段差异 {len(pair['request_json_field_diff'])} 项；原始 body 相同：{pair['request_body_raw_equal']}。")
    models = sorted({m["model"] for s in report["sessions"] for f in s["flows"] for m in f.get("completed_models", []) if "model" in m})
    if models:
        lines += ["", "response.completed 实际模型字段：" + ", ".join("`" + m + "`" for m in models) + "。"]
    lines += ["", "请求头值、Cookie、Token、认证信息、正文标量只展示哈希和长度。TLS 代理、缓冲和 fsync 的影响仍需纳入判断；这些文件不能证明网络指纹完全一致。", ""]
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path, help="Directory containing encrypted capture sessions, recursively")
    parser.add_argument("--output", type=Path, help="Safe report basename or .json/.md path; default ROOT/analysis/capture-comparison")
    parser.add_argument("--key-file", type=Path, default=Path(__file__).with_name("private") / "capture-private.dpapi")
    parser.add_argument("--verify-only", action="store_true", help="Validate integrity and terminal records; skip field comparisons")
    parser.add_argument("--labels", nargs="+", default=LABELS, help="Expected observation point labels")
    args = parser.parse_args(argv)
    try:
        private = load_private(args.key_file)
        report = build_report(args.root, private, args.verify_only, args.labels)
        output = args.output or args.root / "analysis" / "capture-comparison"
        base = output.with_suffix("") if output.suffix.lower() in (".json", ".md") else output
        base.parent.mkdir(parents=True, exist_ok=True)
        base.with_suffix(".json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        base.with_suffix(".md").write_text(markdown(report), encoding="utf-8")
        print(json.dumps({"status": report["status"], "sessions": len(report["sessions"]), "comparison_complete": False, "missing_labels": report["missing_labels_with_flows"]}))
        if args.verify_only and (not report["sessions"] or any(not s["integrity"]["capture_complete"] for s in report["sessions"])):
            return 1
        return 0
    except Exception:
        # Deliberately suppress exception strings and traceback: decrypted values may occur in them.
        print("Capture analysis failed; verify key access, capture format and output permissions.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
