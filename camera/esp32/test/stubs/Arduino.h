// Minimal stand-ins for the Arduino-ESP32 API, ONLY so the firmware can be
// syntax- and type-checked on a PC (test/run.sh). They do nothing useful and say
// nothing about whether the real build works. Signatures follow esp32 core 3.x as
// far as known (ASSUMPTION).
#pragma once
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <string>
#define HIGH 1
#define LOW 0
#define INPUT_PULLUP 2
#define OUTPUT 1
#define RTC_DATA_ATTR
inline void pinMode(int, int) {}
inline void digitalWrite(int, int) {}
inline int digitalRead(int) { return HIGH; }
inline uint32_t millis() { return 0; }
inline void delay(uint32_t) {}
inline void *ps_malloc(size_t n) { return malloc(n); }
inline bool psramFound() { return true; }
inline uint32_t esp_random() { return 4; }
inline void configTime(long, int, const char *, const char * = nullptr) {}
class String {
 public:
  String() {}
  String(const char *s) : s_(s) {}
  String(const std::string &s) : s_(s) {}
  const char *c_str() const { return s_.c_str(); }
  bool startsWith(const char *p) const { return s_.rfind(p, 0) == 0; }
  friend String operator+(const String &a, const String &b) { return String(a.s_ + b.s_); }
  friend String operator+(const String &a, const char *b) { return String(a.s_ + b); }
 private:
  std::string s_;
};
struct SerialStub {
  void begin(int) {}
  void println(const char *) {}
  template <typename... A> void printf(const char *, A...) {}
};
static SerialStub Serial;
