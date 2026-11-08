#pragma once
#include "Arduino.h"
#define WL_CONNECTED 3
#define WIFI_STA 1
#define WIFI_OFF 0
struct WiFiStub {
  int status() { return 0; }
  void mode(int) {}
  void setSleep(bool) {}
  void disconnect(bool) {}
};
static WiFiStub WiFi;
class WiFiClient {};
