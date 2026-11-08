#pragma once
#include "WiFi.h"
class HTTPClient {
 public:
  bool begin(WiFiClient &, const String &) { return true; }
  void setTimeout(uint32_t) {}
  void setConnectTimeout(int32_t) {}
  void addHeader(const String &, const String &) {}
  int POST(uint8_t *, size_t) { return -1; }
  int GET() { return -1; }
  String getString() { return String(); }
  void end() {}
};
