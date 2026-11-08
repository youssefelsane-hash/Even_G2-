"""HTTP behind an interface, plus the multipart encoder for POST /v1/captures."""

from __future__ import annotations

import json
import os
import ssl
import urllib.error
import urllib.request
from dataclasses import dataclass


class TransportError(RuntimeError):
    """Network-level failure: no response at all. Always worth a retry."""


@dataclass
class Response:
    status: int
    body: bytes

    def json(self):
        try:
            return json.loads(self.body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None


class Transport:
    def request(self, method: str, url: str, headers: dict, body: bytes | None = None, timeout: float = 20.0) -> Response:
        raise NotImplementedError


class UrllibTransport(Transport):
    def __init__(self, ca_file: str = "") -> None:
        # System trust store by default. CA_FILE pins a specific root (and a backup root
        # in the same file), so a stolen hotspot cannot impersonate the server.
        self.ctx = ssl.create_default_context(cafile=ca_file or None)

    def request(self, method: str, url: str, headers: dict, body: bytes | None = None, timeout: float = 20.0) -> Response:
        req = urllib.request.Request(url, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=self.ctx) as r:
                return Response(r.status, r.read())
        except urllib.error.HTTPError as e:
            return Response(e.code, e.read() if e.fp else b"")
        except (urllib.error.URLError, OSError, ssl.SSLError) as e:
            raise TransportError(str(getattr(e, "reason", e))) from e


def encode_multipart(parts: list) -> tuple:
    """parts: list of (name, filename or None, content_type, bytes).
    Returns (body, content_type_header)."""
    boundary = "----evencam" + os.urandom(12).hex()
    out = []
    for name, filename, ctype, data in parts:
        disp = 'form-data; name="%s"' % name
        if filename:
            disp += '; filename="%s"' % filename
        out.append(("--%s\r\n" % boundary).encode())
        out.append(("Content-Disposition: %s\r\n" % disp).encode())
        out.append(("Content-Type: %s\r\n\r\n" % ctype).encode())
        out.append(data)
        out.append(b"\r\n")
    out.append(("--%s--\r\n" % boundary).encode())
    return b"".join(out), "multipart/form-data; boundary=%s" % boundary
