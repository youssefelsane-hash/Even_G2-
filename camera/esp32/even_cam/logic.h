// Hardware-free logic shared by the firmware and the host tests (test/host_test.cpp):
// button grammar, LED/motor pattern player, best-K frame selection, retry backoff,
// and a tiny JSON field reader. No Arduino headers here, so it compiles with any
// C++17 compiler.
//
// Same rules as the Linux client (camera/linux/evencam/button.py):
//   single  short press, no second press within DOUBLE_MS of the release
//   double  two short presses
//   long    held LONG_MS; fires while held, release ignored
//   stuck   held STUCK_MS; reported once
// A button already held at start (or after reset()) is ignored until released.
#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>

namespace evencam {

enum class Event : uint8_t { None = 0, Single, Double, Long, Stuck };

struct ButtonTiming {
  uint32_t debounceMs = 30;
  uint32_t longMs = 800;
  uint32_t doubleMs = 350;
  uint32_t stuckMs = 15000;
};

class ButtonGrammar {
 public:
  explicit ButtonGrammar(ButtonTiming t = ButtonTiming()) : t_(t) {}

  void reset(bool pressedNow, uint32_t now) {
    started_ = true;
    raw_ = pressedNow;
    rawChangedAt_ = now;
    stable_ = pressedNow;
    armed_ = !pressedNow;
    longFired_ = false;
    stuckFired_ = false;
    pendingClick_ = false;
  }

  // Feed one sample. Up to 2 events can become certain at once ("single" then "long").
  // Returns the number written to out[0..1].
  int update(bool pressed, uint32_t now, Event out[2]) {
    int n = 0;
    if (!started_) {
      reset(pressed, now);
      return 0;
    }
    if (pressed != raw_) {
      raw_ = pressed;
      rawChangedAt_ = now;
    }
    if (raw_ != stable_ && now - rawChangedAt_ >= t_.debounceMs) {
      stable_ = raw_;
      uint32_t edgeAt = rawChangedAt_;
      if (stable_) {
        if (onPress(edgeAt)) out[n++] = Event::Single;
      } else {
        Event e = onRelease(edgeAt);
        if (e != Event::None) out[n++] = e;
      }
    }
    if (stable_ && armed_) {
      uint32_t held = (raw_ ? now : rawChangedAt_) - pressStart_;
      if (!longFired_ && held >= t_.longMs) {
        longFired_ = true;
        if (pendingClick_) {
          pendingClick_ = false;
          out[n++] = Event::Single;
        }
        if (n < 2) out[n++] = Event::Long;
      }
      if (!stuckFired_ && held >= t_.stuckMs && n < 2) {
        stuckFired_ = true;
        out[n++] = Event::Stuck;
      }
    }
    if (pendingClick_ && !stable_ && !raw_ && now - pendingSince_ >= t_.doubleMs && n < 2) {
      pendingClick_ = false;
      out[n++] = Event::Single;
    }
    return n;
  }

  bool busy() const { return stable_ || pendingClick_; }

 private:
  // Returns true when an earlier click must be reported as "single" now: the
  // second press came too late for a double, but a gap in sampling (capture,
  // Wi-Fi) kept "single" from firing on time. Dropping it would lose a press.
  bool onPress(uint32_t at) {
    if (!armed_) return false;
    pressStart_ = at;
    longFired_ = false;
    stuckFired_ = false;
    if (pendingClick_ && at - pendingSince_ > t_.doubleMs) {
      pendingClick_ = false;
      return true;
    }
    return false;
  }

  Event onRelease(uint32_t at) {
    if (!armed_) {
      armed_ = true;
      return Event::None;
    }
    if (longFired_ || stuckFired_) return Event::None;
    if (pendingClick_) {
      pendingClick_ = false;
      return Event::Double;
    }
    pendingClick_ = true;
    pendingSince_ = at;
    return Event::None;
  }

  ButtonTiming t_;
  bool started_ = false;
  bool raw_ = false;
  uint32_t rawChangedAt_ = 0;
  bool stable_ = false;
  bool armed_ = true;
  uint32_t pressStart_ = 0;
  bool longFired_ = false;
  bool stuckFired_ = false;
  bool pendingClick_ = false;
  uint32_t pendingSince_ = 0;
};

// ---------- LED / motor patterns ----------
// Steps in ms, alternating on/off, starting with on. Same table as the Linux client.
struct Pattern {
  const uint16_t *steps;
  uint8_t count;
};

#define EVENCAM_PATTERN(name, ...)                                   \
  static const uint16_t name##_steps[] = {__VA_ARGS__};              \
  static const Pattern name = {name##_steps, (uint8_t)(sizeof(name##_steps) / sizeof(uint16_t))}

namespace led {
EVENCAM_PATTERN(boot, 200);
EVENCAM_PATTERN(uploaded, 80, 120, 80);
EVENCAM_PATTERN(queued_offline, 400, 400, 400, 400, 400);
EVENCAM_PATTERN(ready, 600);
EVENCAM_PATTERN(retake, 100, 100, 100, 100, 100, 100, 100, 100, 100);
EVENCAM_PATTERN(error, 1200);
EVENCAM_PATTERN(queue_full, 60, 60, 60, 60, 60, 60, 60, 60, 60);
EVENCAM_PATTERN(stuck, 60, 60, 60, 60, 1200);
}  // namespace led
namespace motor {
EVENCAM_PATTERN(captured, 60);
EVENCAM_PATTERN(ready, 60, 100, 60);
EVENCAM_PATTERN(retake, 250, 150, 250);
EVENCAM_PATTERN(error, 400);
}  // namespace motor

class PatternPlayer {
 public:
  static const int kQueue = 6;
  static const uint32_t kGapMs = 150;

  void play(const Pattern &p, uint32_t now) {
    if (p.count == 0) return;
    if (!active_) {
      cur_ = p;
      start_ = now;
      active_ = true;
    } else if (qlen_ < kQueue) {
      q_[qlen_++] = p;
    }
  }

  bool level(uint32_t now) {
    while (active_) {
      uint32_t elapsed = now - start_;
      uint32_t acc = 0;
      for (uint8_t i = 0; i < cur_.count; i++) {
        acc += cur_.steps[i];
        if (elapsed < acc) return (i % 2) == 0;
      }
      uint32_t gapEnd = acc + kGapMs;
      if (qlen_ > 0 && elapsed >= gapEnd) {
        cur_ = q_[0];
        for (int i = 1; i < qlen_; i++) q_[i - 1] = q_[i];
        qlen_--;
        start_ += gapEnd;
        continue;
      }
      if (qlen_ > 0) return false;
      active_ = false;
    }
    return false;
  }

  bool idle() const { return !active_ && qlen_ == 0; }

 private:
  Pattern cur_ = {nullptr, 0};
  Pattern q_[kQueue];
  int qlen_ = 0;
  uint32_t start_ = 0;
  bool active_ = false;
};

// ---------- frame selection ----------
// The ESP32 cannot afford a full decode per frame, so it uses JPEG size as a sharpness
// proxy: at a fixed quality setting, a sharp, well-lit page has more high-frequency
// detail and compresses less. Dark, blurry and blown-out frames come out smaller.
// ASSUMPTION: this ordering holds for OV5640/OV3660 output; EXPERIMENT NEEDED.
// score = size / largest size in the burst, 0..1.
// Picks up to k indices, best first, dropping frames under `floorPct` % of the best.
inline int selectBest(const size_t *sizes, int n, int k, int floorPct, int *outIdx, float *outScore) {
  if (n <= 0 || k <= 0) return 0;
  size_t maxLen = 0;
  for (int i = 0; i < n; i++) if (sizes[i] > maxLen) maxLen = sizes[i];
  bool used[32] = {false};
  int m = 0;
  while (m < k && m < n && m < 32) {
    int best = -1;
    for (int i = 0; i < n && i < 32; i++) {
      if (used[i]) continue;
      if (best < 0 || sizes[i] > sizes[best]) best = i;
    }
    if (best < 0) break;
    float score = maxLen ? (float)sizes[best] / (float)maxLen : 0.0f;
    if (m > 0 && score * 100.0f < (float)floorPct) break;
    used[best] = true;
    outIdx[m] = best;
    outScore[m] = score;
    m++;
  }
  return m;
}

// ---------- retry backoff ----------
// attempt is 1 after the first failure. 2 s doubling, capped at 60 s, plus jitter 0..499 ms.
inline uint32_t backoffMs(uint8_t attempt, uint32_t jitter) {
  uint32_t shift = attempt > 0 ? attempt - 1 : 0;
  if (shift > 5) shift = 5;
  uint32_t b = 2000u << shift;
  if (b > 60000u) b = 60000u;
  return b + (jitter % 500u);
}

// 2xx ok; 408, 429, 5xx and network errors (<= 0) retry; other 4xx are permanent.
enum class Outcome : uint8_t { Ok, Retry, Drop };
inline Outcome classify(int httpCode) {
  if (httpCode >= 200 && httpCode < 300) return Outcome::Ok;
  if (httpCode >= 400 && httpCode < 500 && httpCode != 408 && httpCode != 429) return Outcome::Drop;
  return Outcome::Retry;
}

// ---------- tiny JSON readers (flat objects from our own backend only) ----------
// Finds "key": and copies the following string value. Returns false if absent.
inline bool jsonString(const char *json, const char *key, char *out, size_t outLen) {
  if (!json || !key || outLen == 0) return false;
  char pat[48];
  size_t kl = strlen(key);
  if (kl + 3 > sizeof(pat)) return false;
  pat[0] = '"';
  memcpy(pat + 1, key, kl);
  pat[kl + 1] = '"';
  pat[kl + 2] = '\0';
  const char *p = strstr(json, pat);
  if (!p) return false;
  p += kl + 2;
  while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
  if (*p != ':') return false;
  p++;
  while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
  if (*p != '"') return false;
  p++;
  size_t i = 0;
  while (*p && *p != '"' && i + 1 < outLen) {
    if (*p == '\\') return false;  // our ids and statuses never contain escapes
    out[i++] = *p++;
  }
  if (*p != '"') return false;
  out[i] = '\0';
  return true;
}

// Result of POST /v1/captures. A 2xx counts only when the body names a job: a
// captive portal or a wrong proxy also answers 200, and treating that as success
// would throw the photos away. jobId receives the id on Ok.
inline Outcome uploadOutcome(int httpCode, const char *body, char *jobId, size_t jobIdLen) {
  Outcome o = classify(httpCode);
  if (o != Outcome::Ok) return o;
  if (!jsonString(body, "jobId", jobId, jobIdLen) || jobId[0] == '\0') return Outcome::Retry;
  return Outcome::Ok;
}

// appendTo value for an upload. Presses go out oldest first, so the previous
// upload is the press a double press belongs to. If that press was given up on,
// the page is sent as a new question (nullptr), not glued to an older one.
inline const char *appendTarget(bool append, const char *lastJobId, bool previousDropped) {
  if (!append || previousDropped) return nullptr;
  return (lastJobId && lastJobId[0]) ? lastJobId : "previous";
}

// Integer value of "key": n. Returns fallback if absent or not a number.
inline long jsonInt(const char *json, const char *key, long fallback) {
  if (!json || !key) return fallback;
  char pat[48];
  size_t kl = strlen(key);
  if (kl + 3 > sizeof(pat)) return fallback;
  pat[0] = '"';
  memcpy(pat + 1, key, kl);
  pat[kl + 1] = '"';
  pat[kl + 2] = '\0';
  const char *p = strstr(json, pat);
  if (!p) return fallback;
  p += kl + 2;
  while (*p == ' ') p++;
  if (*p != ':') return fallback;
  p++;
  while (*p == ' ') p++;
  if (!(*p == '-' || (*p >= '0' && *p <= '9'))) return fallback;
  return strtol(p, nullptr, 10);
}

inline long clampLong(long v, long lo, long hi) { return v < lo ? lo : (v > hi ? hi : v); }

}  // namespace evencam
