"""Even G2 camera client for small Linux boards (NanoPi Duo2, Raspberry Pi).

Physical button only. The capture LED lights before every capture and cannot be
turned off. No audio, no remote or timed trigger. Video in clip mode stays on the
device and is deleted after frames are picked.

Needs Python 3.8 or later. Pillow is the only third-party dependency.
"""

__version__ = "0.1.0"
