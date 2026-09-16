"""Append-only encrypted capture. This module never opens or accepts a private key.

events.cap = MAGIC, followed by [sequence:u64, payload_length:u64, ciphertext].
Each AES-GCM payload authenticates MAGIC + stream_id + the exact frame header.
Its nonce is nonce_prefix(4 bytes) + sequence(u64). A complete final frame does
not imply a complete session: readers must also find the encrypted session_end.
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import struct
import threading
import time
import uuid

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAGIC = b"CODEXCAP\x01\r\n"
FRAME = struct.Struct(">QQ")
MAX_FRAME_BYTES = 1024 * 1024 * 1024


def b64(value: bytes | bytearray | memoryview | None):
    return None if value is None else base64.b64encode(bytes(value)).decode("ascii")


class CaptureVault:
    def __init__(self, root, label, public_key_path):
        public_pem = Path(public_key_path).read_bytes()
        public_key = serialization.load_pem_public_key(public_pem)
        if not isinstance(public_key, rsa.RSAPublicKey) or public_key.key_size < 2048:
            raise ValueError("Capture requires an RSA public key of at least 2048 bits")
        self.stream_id = uuid.uuid4().hex
        self.directory = Path(root) / self.stream_id
        self.directory.mkdir(parents=True, exist_ok=False)
        key = AESGCM.generate_key(bit_length=256)
        self._cipher = AESGCM(key)
        self._nonce_prefix = os.urandom(4)
        self._sequence = 0
        self._lock = threading.Lock()
        self._closed = False
        wrapped = public_key.encrypt(
            key,
            padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=b"codex-capture-v1"),
        )
        public_der = public_key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        digest = hashes.Hash(hashes.SHA256())
        digest.update(public_der)
        envelope = {
            "format": "codex-capture-v1",
            "stream_id": self.stream_id,
            "cipher": "AES-256-GCM",
            "wrapping": "RSA-OAEP-SHA256",
            "oaep_label_b64": b64(b"codex-capture-v1"),
            "wrapped_key_b64": b64(wrapped),
            "nonce_prefix_b64": b64(self._nonce_prefix),
            "public_key_sha256": digest.finalize().hex(),
            "frame": "big-endian u64 sequence, u64 ciphertext_length, ciphertext_with_16_byte_tag",
            "aad": "MAGIC || ASCII(stream_id) || exact_16_byte_frame_header",
            "nonce": "nonce_prefix || big-endian_u64_sequence",
        }
        with (self.directory / "header.json").open("xb") as output:
            output.write(json.dumps(envelope, sort_keys=True).encode("utf-8"))
            output.flush()
            os.fsync(output.fileno())
        self._output = (self.directory / "events.cap").open("xb", buffering=0)
        self._write_all(MAGIC)
        self.write("session_start", {"label": label, "pid": os.getpid(), "schema": 1}, sync=True)

    def _write_all(self, value):
        pending = memoryview(value)
        while pending:
            written = self._output.write(pending)
            if not written:
                raise OSError("Capture storage write failed")
            pending = pending[written:]

    def write(self, event, data=None, *, sync=False):
        with self._lock:
            if self._closed:
                raise RuntimeError("Capture vault is closed")
            sequence = self._sequence
            if sequence >= 2**64:
                raise OverflowError("Capture sequence exhausted")
            # Reserve a nonce before any encryption or I/O; never reuse after an error.
            self._sequence += 1
            record = {"schema": 1, "sequence": sequence, "event": event,
                      "wall_time_ns": time.time_ns(), "monotonic_ns": time.monotonic_ns(), "data": data}
            plaintext = json.dumps(record, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
            size = len(plaintext) + 16
            if size > MAX_FRAME_BYTES:
                raise ValueError("Capture frame exceeds storage format bound")
            frame = FRAME.pack(sequence, size)
            nonce = self._nonce_prefix + struct.pack(">Q", sequence)
            aad = MAGIC + self.stream_id.encode("ascii") + frame
            ciphertext = self._cipher.encrypt(nonce, plaintext, aad)
            self._write_all(frame)
            self._write_all(ciphertext)
            if sync:
                self._output.flush()
                os.fsync(self._output.fileno())
            return sequence

    def close(self, data=None):
        if self._closed:
            return
        self.write("session_end", data, sync=True)
        with self._lock:
            self._closed = True
            self._output.close()
