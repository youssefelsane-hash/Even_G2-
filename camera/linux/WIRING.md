# Wiring: button, LED, vibration motor, fill light, battery

**Nothing here has been built or measured.** Pin numbers for the NanoPi Duo2 come from the
FriendlyElec wiki's table of sysfs numbers [1]; where each one sits on the header was not
confirmed. Check the board's silkscreen and the wiki pin diagram before soldering.

## Parts

| Part | Notes |
| --- | --- |
| Momentary push button | Normally open. Big enough to find by feel |
| LED, bright, colour that reads as "recording" (red or white) | Front of the case, next to the lens, visible from 2 m in daylight |
| NPN transistor x3 (2N2222, BC337 or similar), or logic-level N-MOSFETs | One each for LED, motor and fill light, so the GPIO pin only drives a few mA |
| Resistors: 1 kOhm x3 (transistor bases), 10 kOhm x1 (button pull-up), LED resistors (below) | |
| Coin vibration motor, 3 V (optional) | Plus a 1N4148 diode across it |
| White LED for fill light (optional), with a diffuser | |
| Power: USB power bank, or 1S LiPo + charger board + 5 V boost board rated 2 A | See battery section |

## Circuits

**Button.** Between the button pin and GND. Add a 10 kOhm pull-up from the pin to 3.3 V.
The Duo2 sysfs interface cannot switch on an internal pull-up; the Raspberry Pi can, but
the external resistor does no harm. Software handles bounce (30 ms).

```
3.3V --[10k]--+-- BUTTON_PIN
              |
           [button]
              |
             GND
```

**LED, motor and fill light: transistor switch.** The GPIO drives the transistor base
through 1 kOhm. The load runs from 5 V.

```
5V --[R]--[LED]--+            5V --+--[motor]--+         (diode across the motor,
                 |                 |           |          stripe towards 5V)
              C  |                 +--|<|------+
GPIO --[1k]-- B NPN             GPIO --[1k]-- B NPN
              E  |                            E
                GND                           GND
```

LED resistor from 5 V: (5 V - LED forward voltage) / current. Red LED (about 2 V) at
15 mA: 200 Ohm. White LED (about 3 V) at 20 mA: 100 Ohm. ASSUMPTION: typical LED values;
check the LED's datasheet.

Direct drive (no transistor) works for a small indicator LED at a few mA: GPIO, 330 Ohm,
LED, GND. It may not be bright enough in daylight (EXPERIMENT NEEDED, camera README K5).

## Pin choices

### NanoPi Duo2 (`GPIO_BACKEND=sysfs`, numbers are sysfs numbers)

| Function | Wiki name | sysfs number | Status |
| --- | --- | --- | --- |
| Button | PG11 (GPIOG11) | 203 | ASSUMPTION from [1] |
| LED | TX1 (UART1_TX / GPIOG6) | 198 | ASSUMPTION: UART1 must not be in use |
| Motor | RX1 (UART1_RX / GPIOG7) | 199 | ASSUMPTION: as above |
| Fill light | CS (SPI1_CS / GPIOA13) | 13 | ASSUMPTION: SPI1 must not be in use |

Setup writes the button and LED numbers into `camera.env`; add `MOTOR_PIN` and
`FILL_LIGHT_PIN` yourself. To test a pin by hand before wiring anything else:

```bash
echo 198 | sudo tee /sys/class/gpio/export
echo out | sudo tee /sys/class/gpio/gpio198/direction
echo 1 | sudo tee /sys/class/gpio/gpio198/value     # LED on
echo 0 | sudo tee /sys/class/gpio/gpio198/value     # LED off
```

The camera ribbon goes in the Duo2's camera connector; `/dev/video0` should appear [1].

### Raspberry Pi Zero 2 W (`GPIO_BACKEND=gpiod`, numbers are BCM line offsets on gpiochip0)

| Function | BCM | Header pin | Status |
| --- | --- | --- | --- |
| Button | 17 | 11 | ASSUMPTION: standard 40-pin layout; check pinout.xyz |
| LED | 27 | 13 | ASSUMPTION |
| Motor | 22 | 15 | ASSUMPTION |
| Fill light | 23 | 16 | ASSUMPTION |
| GND | - | 9, 14 | |

## Battery

The Duo2 needs 5 V, rated 2 A [1]. The Pi Zero 2 W also takes 5 V.

1. **Simplest: a small USB power bank** into the micro-USB power port. No soldering. Some
   power banks switch off when the current is low; pick one with an "always on" or
   low-current mode (EXPERIMENT NEEDED).
2. **Built in: 1S LiPo (1000 to 2000 mAh) + charger board (TP4056 type with protection) +
   5 V boost board rated 2 A** into the 5 V pin. The boost board must handle the current
   spike when the camera and Wi-Fi start, or the board resets (EXPERIMENT NEEDED).

Rough run time: if the Duo2 with Wi-Fi draws about 1 W, a 2,000 mAh cell (about 7 Wh)
lasts about 5 to 6 hours after conversion losses. ESTIMATE, measure it (camera README K8).

Battery percent is optional. If your power board exposes a capacity file (some UPS boards
for the Pi do), set `BATTERY_FILE` to it and the percent goes with each press.

## Enclosure

- Lens and LED side by side on the front, so the LED cannot be covered without covering
  the lens.
- Must look like a camera: no watch shape, no disguise.
- Vents: the board gets warm with Wi-Fi and the camera running.

[1] FriendlyElec wiki, NanoPi Duo2: https://wiki.friendlyelec.com/wiki/index.php/NanoPi_Duo2 (read 2026-11-08)
