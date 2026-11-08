// Copy this file to config.h (git-ignored) and fill it in.
// No AI key belongs here: the camera only knows how to reach your own backend.
#pragma once

// Phone hotspot first (2.4 GHz, auto-off disabled), then home Wi-Fi.
#define WIFI_SSID_1 "MyPhoneHotspot"
#define WIFI_PASS_1 "hotspot-password"
#define WIFI_SSID_2 ""
#define WIFI_PASS_2 ""

// Backend base URL, no trailing slash. Must be https:// in real use.
#define SERVER_URL "https://assistant.example.com"

// Upload-only device token from: node backend/scripts/make-token.mjs device
#define DEVICE_TOKEN "paste-device-token-here"
#define DEVICE_ID "cam1"

// Root CA (PEM) of the server's TLS chain, plus a backup root if you have one.
// Leave the placeholder ONLY for plain-http tests on your own network.
static const char ROOT_CA_PEM[] = R"PEM(
-----BEGIN CERTIFICATE-----
...paste ISRG Root X1 or your CA here...
-----END CERTIFICATE-----
)PEM";

// Pins on the XIAO ESP32-S3 Sense (ASSUMPTION from the Seeed pinout; check before wiring).
// D1 = GPIO2: shutter button to GND (internal pull-up). Also the deep-sleep wake pin.
#define BUTTON_PIN 2
// D3 = GPIO4: external capture LED through a resistor (see camera/linux/WIRING.md).
#define LED_PIN 4
// D4 = GPIO5: optional vibration motor through a transistor. Comment out if not fitted.
// #define MOTOR_PIN 5

// Stay awake this long after the last activity, then deep sleep (button wakes it).
#define STAY_AWAKE_MS (5UL * 60UL * 1000UL)

// Uncomment only with an OV5640 module and the ESP32_OV5640_AF library installed.
// #define USE_OV5640_AF
