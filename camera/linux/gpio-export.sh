#!/bin/sh
# Prepare sysfs GPIO pins for the camera service (run as root by systemd ExecStartPre).
# Reads BUTTON_PIN, LED_PIN, MOTOR_PIN, FILL_LIGHT_PIN and GPIO_BACKEND from the
# environment (camera.env). With GPIO_BACKEND=gpiod it does nothing.
set -eu
[ "${GPIO_BACKEND:-gpiod}" = "sysfs" ] || exit 0
SYSFS=/sys/class/gpio
for pin in "${BUTTON_PIN:-}" "${LED_PIN:-}" "${MOTOR_PIN:-}" "${FILL_LIGHT_PIN:-}"; do
  [ -n "$pin" ] || continue
  case "$pin" in *[!0-9]*) echo "bad pin number: $pin" >&2; exit 1 ;; esac
  if [ ! -d "$SYSFS/gpio$pin" ]; then
    echo "$pin" > "$SYSFS/export"
    sleep 0.1
  fi
  for f in direction value active_low edge; do
    if [ -e "$SYSFS/gpio$pin/$f" ]; then
      chgrp evencam "$SYSFS/gpio$pin/$f"
      chmod g+rw "$SYSFS/gpio$pin/$f"
    fi
  done
done
# LED off and output before the client starts. "low" sets direction and level together.
if [ -n "${LED_PIN:-}" ]; then
  if [ "${LED_ACTIVE_LOW:-0}" = "1" ]; then echo high > "$SYSFS/gpio$LED_PIN/direction"
  else echo low > "$SYSFS/gpio$LED_PIN/direction"; fi
fi
