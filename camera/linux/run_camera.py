"""Start the camera client: python3 -I /opt/even-g2-camera/run_camera.py

Isolated mode (-I) ignores PYTHONPATH and does not add the script folder to the
import path, so this file adds its own folder explicitly. The systemd unit runs it.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from evencam.__main__ import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
