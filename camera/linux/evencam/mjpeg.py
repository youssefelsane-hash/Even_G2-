"""Split a Motion-JPEG stream (concatenated JPEG images) into single frames.

Both ffmpeg (-f mjpeg) and rpicam-vid (--codec mjpeg) write this format. The parser
walks JPEG segments by their length fields, so an embedded EXIF thumbnail (which
has its own start and end markers) does not split a frame in two. Garbage between
frames is skipped. A truncated last frame is dropped.
"""

from __future__ import annotations

SOI = b"\xff\xd8"


def _frame_end(data: bytes, start: int) -> int:
    """Index just past the EOI of the JPEG starting at `start`, or -1."""
    n = len(data)
    i = start + 2
    while i + 4 <= n:
        if data[i] != 0xFF:
            return -1
        marker = data[i + 1]
        if marker == 0xFF:  # fill byte
            i += 1
            continue
        if marker == 0xD9:  # EOI with no scan: odd, but complete
            return i + 2
        if 0xD0 <= marker <= 0xD7 or marker == 0x01:
            i += 2
            continue
        seg_len = (data[i + 2] << 8) | data[i + 3]
        if seg_len < 2:
            return -1
        if marker == 0xDA:  # start of scan: entropy data follows
            j = i + 2 + seg_len
            while j + 1 < n:
                if data[j] == 0xFF:
                    nxt = data[j + 1]
                    if nxt == 0x00 or 0xD0 <= nxt <= 0xD7 or nxt == 0xFF:
                        j += 2 if nxt != 0xFF else 1
                        continue
                    if nxt == 0xD9:
                        return j + 2
                    # another marker (e.g. progressive DHT/SOS): resume segment walk
                    i = j
                    break
                j += 1
            else:
                return -1
            continue
        i += 2 + seg_len
    return -1


def split_mjpeg(data: bytes) -> list[bytes]:
    frames: list[bytes] = []
    pos = 0
    while True:
        start = data.find(SOI, pos)
        if start < 0:
            break
        end = _frame_end(data, start)
        if end < 0:
            # Not a valid frame here. Skip past this SOI and keep looking.
            pos = start + 2
            continue
        frames.append(data[start:end])
        pos = end
    return frames


def sample_evenly(items: list, n: int) -> list:
    """Pick n items spread over the list, keeping order."""
    if n <= 0 or not items:
        return []
    if n >= len(items):
        return list(items)
    if n == 1:
        return [items[len(items) // 2]]
    step = (len(items) - 1) / (n - 1)
    return [items[int(round(i * step))] for i in range(n)]
