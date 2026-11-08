"""Offline queue, uploads with retry, job status polling and config refresh.

Queue
- One folder per press under STATE_DIR/queue (a RAM disk under /run on the device,
  so photos never reach the SD card and vanish on power loss).
- The folder name is the Idempotency-Key, made once per press and reused on every
  retry, so the server returns the same job for a repeated upload.
- Oldest first, so answers and appended pages arrive in press order.
- At most `max_queue` presses wait. A new press beyond that is refused (the user
  sees "queue_full"), because silently dropping an older question is worse.
- A press older than MAX_AGE_S is dropped with the "error" pattern. The server keeps
  idempotency keys longer than that.

Retry
- Network error, 408, 429, 5xx, and any 2xx that does not name a jobId (captive
  portal, wrong proxy): retry with exponential backoff (2 s doubling to
  60 s) plus up to 0.5 s jitter.
- Other 4xx (bad token, bad request, too large): never succeeds, drop now, "error".
- The first failed attempt of a press plays "queued_offline" once.

Status polling
- After a 202 the camera polls GET /v1/captures/:jobId every POLL_EVERY_S for up to
  POLL_FOR_S. "retake" plays the retake pattern (reason is on the lens), "ready"
  plays "ready", "failed" plays "error". Nothing else is fetched: the camera never
  sees answer text.

Appending (double press)
- A double press records the local key of the previous press. At upload time it
  becomes that press's jobId if known, otherwise "previous" for the server to
  resolve.
"""

from __future__ import annotations

import json
import os
import random
import shutil
import threading
import uuid
from dataclasses import dataclass, field
from typing import Callable

from .config import CameraConfig, LocalSettings, parse_camera_config
from .transport import Response, Transport, TransportError, encode_multipart

BACKOFF_BASE_S = 2.0
BACKOFF_MAX_S = 60.0
MAX_AGE_S = 15 * 60.0
POLL_EVERY_S = 2.0
POLL_FOR_S = 60.0  # upper bound; the config's statusPollSeconds (default 30) applies
CONFIG_REFRESH_S = 300.0
CONFIG_RETRY_S = 30.0
HTTP_TIMEOUT_S = 25.0


class QueueFull(RuntimeError):
    pass


@dataclass
class Item:
    key: str
    meta: dict
    frame_files: list
    created_at: float
    append_after: str | None = None  # local key of the press this one appends to
    attempts: int = 0
    next_try: float = 0.0
    notified_offline: bool = False


@dataclass
class PollTask:
    job_id: str
    until: float
    next_poll: float


@dataclass
class UploadStats:
    uploaded: int = 0
    dropped: int = 0
    retried: int = 0
    statuses: list = field(default_factory=list)


class Uploader:
    def __init__(
        self,
        settings: LocalSettings,
        transport: Transport,
        now: Callable[[], float],
        notify: Callable[[str], None],
        rng: random.Random | None = None,
    ) -> None:
        self.s = settings
        self.transport = transport
        self.now = now
        self.notify = notify
        self.rng = rng or random.Random()
        self.lock = threading.RLock()
        self.items: list[Item] = []
        self.polls: list[PollTask] = []
        self.job_ids: dict[str, str] = {}  # local key -> server jobId
        self.dropped_keys: set[str] = set()  # presses given up on; a page meant for them starts a new question
        self.last_key: str | None = None
        self.config = CameraConfig()
        self.config_loaded = False
        self.next_config_fetch = 0.0
        self.stats = UploadStats()
        os.makedirs(self.s.queue_dir, mode=0o700, exist_ok=True)
        self._load_from_disk()

    # ----- helpers -----
    def _headers(self) -> dict:
        return {
            "Authorization": "Bearer %s" % self.s.device_token,
            "X-Device-Id": self.s.device_id,
            "Accept": "application/json",
            "User-Agent": "even-g2-camera/0.1",
        }

    def _dir(self, key: str) -> str:
        return os.path.join(self.s.queue_dir, key)

    def _save_state(self, item: Item) -> None:
        state = {
            "key": item.key,
            "meta": item.meta,
            "frame_files": item.frame_files,
            "append_after": item.append_after,
            "attempts": item.attempts,
            "age_s": max(0.0, self.now() - item.created_at),
        }
        path = os.path.join(self._dir(item.key), "state.json")
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(state, f)
        os.replace(tmp, path)

    def _load_from_disk(self) -> None:
        """Resume presses left in the RAM queue after a client restart (not a reboot)."""
        try:
            names = sorted(os.listdir(self.s.queue_dir))
        except OSError:
            return
        loaded = []
        for name in names:
            d = self._dir(name)
            try:
                with open(os.path.join(d, "state.json")) as f:
                    st = json.load(f)
                files = [os.path.join(d, os.path.basename(p)) for p in st["frame_files"]]
                if not files or not all(os.path.exists(p) for p in files):
                    raise ValueError("missing frames")
                item = Item(
                    key=st["key"],
                    meta=st["meta"],
                    frame_files=files,
                    created_at=self.now() - float(st.get("age_s", 0.0)),
                    append_after=st.get("append_after"),
                    attempts=int(st.get("attempts", 0)),
                    next_try=self.now(),
                    notified_offline=True,
                )
                loaded.append(item)
            except (OSError, ValueError, KeyError, TypeError):
                shutil.rmtree(d, ignore_errors=True)
        loaded.sort(key=lambda i: i.created_at)
        self.items = loaded

    def _drop(self, item: Item, pattern: str | None) -> None:
        shutil.rmtree(self._dir(item.key), ignore_errors=True)
        if item in self.items:
            self.items.remove(item)
        if pattern:
            self.dropped_keys.add(item.key)
            self.stats.dropped += 1
            self.notify(pattern)

    # ----- queue -----
    def enqueue(self, meta: dict, frames: list, append: bool = False) -> str:
        """frames: list of JPEG bytes, already scored and named frame0..frame2."""
        with self.lock:
            if len(self.items) >= self.s.max_queue:
                raise QueueFull()
            key = uuid.uuid4().hex
            d = self._dir(key)
            os.makedirs(d, mode=0o700)
            files = []
            for i, data in enumerate(frames):
                p = os.path.join(d, "frame%d.jpg" % i)
                with open(p, "wb") as f:
                    f.write(data)
                files.append(p)
            item = Item(
                key=key,
                meta=dict(meta),
                frame_files=files,
                created_at=self.now(),
                append_after=self.last_key if append else None,
                next_try=self.now(),
            )
            if append and self.last_key is None:
                item.meta["appendTo"] = "previous"
            self._save_state(item)
            self.items.append(item)
            self.last_key = key
            return key

    def pending(self) -> int:
        with self.lock:
            return len(self.items)

    # ----- one step of work; the service thread calls this in a loop -----
    def service(self) -> None:
        self._maybe_fetch_config()
        self._upload_due()
        self._poll_due()

    def _build_body(self, item: Item) -> tuple:
        meta = dict(item.meta)
        if item.append_after is not None:
            if item.append_after in self.job_ids:
                meta["appendTo"] = self.job_ids[item.append_after]
            elif item.append_after in self.dropped_keys:
                # The press this page belongs to never reached the server. "previous"
                # would attach it to an older, unrelated question: send it on its own.
                meta.pop("appendTo", None)
            else:
                meta["appendTo"] = "previous"
        parts = [("meta", None, "application/json", json.dumps(meta, separators=(",", ":")).encode())]
        for i, p in enumerate(item.frame_files):
            with open(p, "rb") as f:
                parts.append(("frame%d" % i, "frame%d.jpg" % i, "image/jpeg", f.read()))
        return encode_multipart(parts)

    def _upload_due(self) -> None:
        with self.lock:
            now = self.now()
            for item in list(self.items):
                if now - item.created_at > MAX_AGE_S:
                    self._drop(item, "error")
            if not self.items:
                return
            item = self.items[0]
            if now < item.next_try:
                return
            body, ctype = self._build_body(item)
        headers = self._headers()
        headers["Content-Type"] = ctype
        headers["Idempotency-Key"] = item.key
        try:
            resp: Response | None = self.transport.request(
                "POST", self.s.server_url + "/v1/captures", headers, body, timeout=HTTP_TIMEOUT_S
            )
        except TransportError:
            resp = None
        with self.lock:
            if item not in self.items:
                return
            item.attempts += 1
            data = resp.json() if resp is not None and 200 <= resp.status < 300 else None
            job_id = data.get("jobId") if isinstance(data, dict) else None
            # Only a reply that names a job counts. A bare 2xx can come from a captive
            # portal or a wrong proxy; treating it as success would lose the press.
            ok = isinstance(job_id, str) and bool(job_id)
            if ok:
                self.stats.uploaded += 1
                self._drop(item, None)
                self.notify("uploaded")
                self.job_ids[item.key] = job_id
                status = data.get("status")
                if status in ("ready", "retake", "failed"):
                    self._signal_status(status)
                else:
                    t = self.now()
                    poll_for = min(POLL_FOR_S, float(self.config.status_poll_seconds))
                    if poll_for > 0:
                        self.polls.append(PollTask(job_id, t + poll_for, t + POLL_EVERY_S))
                return
            status = resp.status if resp is not None else 0
            permanent = resp is not None and 400 <= status < 500 and status not in (408, 429)
            if permanent:
                self._drop(item, "error")
                return
            self.stats.retried += 1
            if not item.notified_offline:
                item.notified_offline = True
                self.notify("queued_offline")
            backoff = min(BACKOFF_MAX_S, BACKOFF_BASE_S * (2 ** min(item.attempts - 1, 6)))
            item.next_try = self.now() + backoff + self.rng.uniform(0, 0.5)
            try:
                self._save_state(item)
            except OSError:
                pass

    def _signal_status(self, status: str) -> None:
        self.stats.statuses.append(status)
        if status == "retake":
            self.notify("retake")
        elif status == "ready":
            self.notify("ready")
        elif status == "failed":
            self.notify("error")

    def _poll_due(self) -> None:
        with self.lock:
            now = self.now()
            self.polls = [p for p in self.polls if now <= p.until]
            due = [p for p in self.polls if now >= p.next_poll]
        for task in due:
            try:
                resp = self.transport.request(
                    "GET", self.s.server_url + "/v1/captures/" + task.job_id, self._headers(), None, timeout=10.0
                )
            except TransportError:
                resp = None
            with self.lock:
                task.next_poll = self.now() + POLL_EVERY_S
                if resp is None:
                    continue
                if resp.status == 404 or (400 <= resp.status < 500 and resp.status not in (408, 429)):
                    if task in self.polls:
                        self.polls.remove(task)
                    continue
                data = resp.json()
                status = data.get("status") if isinstance(data, dict) else None
                if status in ("ready", "retake", "failed"):
                    if task in self.polls:
                        self.polls.remove(task)
                    self._signal_status(status)

    # ----- config -----
    def _maybe_fetch_config(self, force: bool = False) -> None:
        if not force and self.now() < self.next_config_fetch:
            return
        try:
            resp = self.transport.request("GET", self.s.server_url + "/v1/camera/config", self._headers(), None, timeout=10.0)
        except TransportError:
            resp = None
        with self.lock:
            if resp is not None and resp.status == 200:
                self.config = parse_camera_config(resp.json(), self.config)
                self.config_loaded = True
                self.next_config_fetch = self.now() + CONFIG_REFRESH_S
            else:
                # keep the last good config (or defaults) and try again soon
                self.next_config_fetch = self.now() + CONFIG_RETRY_S

    def fetch_config_now(self) -> CameraConfig:
        self._maybe_fetch_config(force=True)
        return self.config

    @property
    def idle(self) -> bool:
        with self.lock:
            return not self.items and not self.polls
