#!/usr/bin/env bash
# Install the Even G2 camera client on a NanoPi Duo2 (FriendlyCore or Armbian) or a
# Raspberry Pi (Raspberry Pi OS). Run on the board, from the repository:
#
#   sudo camera/linux/setup.sh                 # detect board, install, enable service
#   sudo camera/linux/setup.sh --board duo2    # or --board pi
#   sudo camera/linux/setup.sh --start         # also start the service now
#   camera/linux/setup.sh --dry-run --board pi # print what would happen, change nothing
#
# It installs packages from the OS repositories only (python3-pil, ffmpeg or
# rpicam-apps, python3-libgpiod), creates a service user without a login, copies the
# client to /opt/even-g2-camera, and writes /etc/even-g2-camera/camera.env from the
# example if it does not exist yet (chmod 600). It never overwrites an existing
# camera.env and never touches network settings.
#
# NOT TESTED ON A REAL BOARD. EXPERIMENT NEEDED.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PREFIX=/opt/even-g2-camera
ETC=/etc/even-g2-camera
UNIT=/etc/systemd/system/even-g2-camera.service
BOARD=auto
DRY=0
START=0

while [ $# -gt 0 ]; do
  case "$1" in
    --board) BOARD="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --start) START=1; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

run() {
  if [ "$DRY" = 1 ]; then echo "+ $*"; else "$@"; fi
}

say() { echo "==> $*"; }

if [ "$DRY" = 0 ] && [ "$(id -u)" != 0 ]; then
  echo "run with sudo (or use --dry-run)" >&2
  exit 1
fi

# ---- board detection ----
if [ "$BOARD" = auto ]; then
  model="$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || true)"
  case "$model" in
    *"Raspberry Pi"*) BOARD=pi ;;
    *NanoPi*Duo2*|*"NanoPi-Duo2"*|*"NanoPi Duo2"*) BOARD=duo2 ;;
    *) echo "cannot tell the board from '$model'; pass --board pi or --board duo2" >&2; exit 1 ;;
  esac
fi
case "$BOARD" in pi|duo2) ;; *) echo "--board must be pi or duo2" >&2; exit 2 ;; esac
say "board: $BOARD"

# ---- python version ----
if [ "$DRY" = 0 ]; then
  if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'; then
    echo "Python 3.8 or newer is needed. FriendlyCore 16.04 (Xenial) ships 3.5:" >&2
    echo "use a newer FriendlyCore (Focal) or Armbian image instead." >&2
    exit 1
  fi
fi

# ---- packages ----
PKGS="python3 python3-pil v4l-utils"
if [ "$BOARD" = pi ]; then
  PKGS="$PKGS python3-libgpiod"
  if ! command -v rpicam-vid >/dev/null 2>&1 && ! command -v libcamera-vid >/dev/null 2>&1; then
    PKGS="$PKGS rpicam-apps"
  fi
else
  PKGS="$PKGS ffmpeg"
fi
say "installing: $PKGS"
run apt-get update
# shellcheck disable=SC2086
run apt-get install -y --no-install-recommends $PKGS

# ---- user and groups ----
for g in gpio video; do
  if ! getent group "$g" >/dev/null 2>&1; then run groupadd --system "$g"; fi
done
if ! id evencam >/dev/null 2>&1; then
  run useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin \
    --groups video,gpio evencam
fi
# gpiochip access for the gpio group (Raspberry Pi OS already has an equivalent rule).
RULE=/etc/udev/rules.d/60-even-g2-camera-gpio.rules
if [ ! -e "$RULE" ]; then
  if [ "$DRY" = 1 ]; then echo "+ write $RULE"; else
    echo 'SUBSYSTEM=="gpio", KERNEL=="gpiochip*", GROUP="gpio", MODE="0660"' > "$RULE"
    udevadm control --reload-rules || true
    udevadm trigger --subsystem-match=gpio || true
  fi
fi

# ---- files ----
say "copying client to $PREFIX"
run mkdir -p "$PREFIX"
run rm -rf "$PREFIX/evencam"
run cp -r "$HERE/evencam" "$PREFIX/evencam"
run cp "$HERE/run_camera.py" "$HERE/gpio-export.sh" "$PREFIX/"
run find "$PREFIX" -name __pycache__ -prune -exec rm -rf {} +
run chown -R root:root "$PREFIX"
run chmod -R u=rwX,go=rX "$PREFIX"
run chmod 755 "$PREFIX/gpio-export.sh"

run mkdir -p "$ETC"
run chmod 700 "$ETC"
if [ ! -e "$ETC/camera.env" ]; then
  say "writing $ETC/camera.env from the example (edit it before starting)"
  run cp "$HERE/camera.env.example" "$ETC/camera.env"
  if [ "$BOARD" = duo2 ]; then
    # Duo2 defaults: OV5640 on /dev/video0 through ffmpeg, sysfs GPIO.
    # Pin numbers are ASSUMPTIONS from the FriendlyElec wiki table; check WIRING.md.
    run sed -i -e 's/^CAMERA_SOURCE=.*/CAMERA_SOURCE=v4l2/' \
      -e 's/^GPIO_BACKEND=.*/GPIO_BACKEND=sysfs/' \
      -e 's/^BUTTON_PIN=.*/BUTTON_PIN=203/' \
      -e 's/^LED_PIN=.*/LED_PIN=198/' "$ETC/camera.env"
  else
    run sed -i -e 's/^CAMERA_SOURCE=.*/CAMERA_SOURCE=libcamera/' \
      -e 's/^GPIO_BACKEND=.*/GPIO_BACKEND=gpiod/' "$ETC/camera.env"
  fi
fi
run chown root:root "$ETC/camera.env"
run chmod 600 "$ETC/camera.env"

# ---- service ----
run cp "$HERE/systemd/even-g2-camera.service" "$UNIT"
run systemctl daemon-reload
run systemctl enable even-g2-camera.service

if [ "$BOARD" = duo2 ] && [ "$DRY" = 0 ] && [ ! -e /dev/video0 ]; then
  echo "warning: /dev/video0 not found. Check the camera ribbon and the camera overlay." >&2
fi

if [ "$START" = 1 ]; then
  run systemctl restart even-g2-camera.service
  say "started. Logs: journalctl -u even-g2-camera -f"
else
  cat <<MSG
==> installed, not started.
    1. Edit $ETC/camera.env: SERVER_URL, DEVICE_TOKEN, DEVICE_ID, pins.
    2. Connect the board to the phone hotspot (2.4 GHz), e.g.:
         sudo nmcli dev wifi connect "<hotspot name>" password "<password>"
    3. sudo systemctl start even-g2-camera
    4. journalctl -u even-g2-camera -f
MSG
fi
