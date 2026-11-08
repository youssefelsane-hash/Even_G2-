"""Run the camera client tests: python3 -I camera/linux/run_tests.py [-v]

Uses only the standard library plus Pillow. -I (isolated mode) keeps the current
directory and user site-packages off the import path, so this script adds its own
folder explicitly.
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

if __name__ == "__main__":
    verbosity = 2 if "-v" in sys.argv else 1
    suite = unittest.defaultTestLoader.discover(os.path.join(HERE, "tests"), top_level_dir=HERE)
    result = unittest.TextTestRunner(verbosity=verbosity).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
