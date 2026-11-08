// Even G2 camera firmware for the Seeed XIAO ESP32-S3 Sense. Burst mode only.
//
// Ported from the Study Lens firmware (study_cam.ino). NEVER COMPILED OR FLASHED:
// no Arduino toolchain was available when this was written. Treat every line as
// EXPERIMENT NEEDED. The hardware-free logic (logic.h) is tested on a PC.
//
// Button grammar (one physical button, the only way to take pictures):
//   single press  burst of N frames (config, default 4) over about 1 s, best K (<= 3) uploaded
//   double press  same, sent as an extra page of the previous question (appendTo)
//   long press    long burst of 8 frames (the ESP32 has no clip mode), best K uploaded
// The external LED is on at least 500 ms before the sensor is read and stays on until
// the upload has been tried. There is no setting that turns it off.
// No video, no audio: the Sense microphone is never initialised.
// Photos live in PSRAM only, never on flash or SD.
//
// Power: deep sleep after STAY_AWAKE_MS without activity; the button wakes the board.
//
// Board: "XIAO_ESP32S3" (esp32 core 3.x), Tools > PSRAM: "OPI PSRAM".

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiMulti.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <time.h>
#include "esp_camera.h"
#include "esp_sleep.h"
#include "driver/rtc_io.h"
#include "config.h"
#include "logic.h"

using namespace evencam;

#ifdef USE_OV5640_AF
#include "ESP32_OV5640_AF.h"
OV5640 ov5640;
#endif

// XIAO ESP32-S3 Sense camera pins (Seeed wiki, same as Study Lens).
#define PWDN_GPIO_NUM -1
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 10
#define SIOD_GPIO_NUM 40
#define SIOC_GPIO_NUM 39
#define Y9_GPIO_NUM 48
#define Y8_GPIO_NUM 11
#define Y7_GPIO_NUM 12
#define Y6_GPIO_NUM 14
#define Y5_GPIO_NUM 16
#define Y4_GPIO_NUM 18
#define Y3_GPIO_NUM 17
#define Y2_GPIO_NUM 15
#define VSYNC_GPIO_NUM 38
#define HREF_GPIO_NUM 47
#define PCLK_GPIO_NUM 13

static const uint32_t PRE_CAPTURE_LED_MS = 500;   // fixed by the spec, not configurable
static const uint32_t UPLOAD_LED_HOLD_MS = 30000;
static const uint32_t BURST_MS = 1000;
static const uint32_t POLL_EVERY_MS = 2000;
static const uint32_t POLL_FOR_MS = 60000;  // upper bound; statusPollSeconds (default 30) applies
static const uint32_t MAX_AGE_MS = 15UL * 60UL * 1000UL;
static const uint32_t HTTP_TIMEOUT_MS = 20000;
static const int MAX_PENDING = 3;
static const int MAX_KEEP = 3;
static const int MAX_FRAMES = 8;
static const int RELATIVE_FLOOR_PCT = 35;

// ---------- settings that survive deep sleep ----------
struct CamConfig {
  uint8_t burstFrames;
  uint8_t keepBest;
  uint8_t longBurstFrames;
  bool singleMode;  // defaultMode == "single"
  uint8_t pollSeconds;  // statusPollSeconds
  bool loaded;
};
RTC_DATA_ATTR static CamConfig cfg = {4, 3, 8, false, 30, false};
RTC_DATA_ATTR static char lastJobId[48] = "";
RTC_DATA_ATTR static bool lastPressDropped = false;  // the most recent upload was given up on

// ---------- queue in PSRAM ----------
struct Frame {
  uint8_t *buf;
  size_t len;
  uint16_t w, h;
  float score;
};
struct Capture {
  Frame frames[MAX_KEEP];
  uint8_t nFrames;
  char key[33];
  char mode[8];          // "single" or "burst"
  bool append;
  uint8_t attempts;
  uint32_t nextTryMs;
  uint32_t createdMs;
  bool notifiedOffline;
  time_t capturedAt;
};
static Capture pending[MAX_PENDING];
static int pendingCount = 0;

struct Poll {
  char jobId[48];
  uint32_t untilMs;
  uint32_t nextMs;
  bool active;
};
static Poll poll = {"", 0, 0, false};

static WiFiMulti wifiMulti;
static ButtonGrammar grammar;
static PatternPlayer ledPlayer, motorPlayer;
static int busyCount = 0;
static uint32_t ledHoldUntil = 0;
static char ledHoldKey[33] = "";
static uint32_t lastActivityMs = 0;
static bool timeSynced = false;

// ---------- outputs ----------
static void applyOutputs() {
  uint32_t now = millis();
  bool hold = ledHoldKey[0] != '\0' && (int32_t)(ledHoldUntil - now) > 0;
  digitalWrite(LED_PIN, (busyCount > 0 || hold || ledPlayer.level(now)) ? HIGH : LOW);
#ifdef MOTOR_PIN
  digitalWrite(MOTOR_PIN, motorPlayer.level(now) ? HIGH : LOW);
#endif
}

static void play(const Pattern &l) { ledPlayer.play(l, millis()); }
static void buzz(const Pattern &m) { motorPlayer.play(m, millis()); }

static void releaseHold(const char *key) {
  if (ledHoldKey[0] && strcmp(ledHoldKey, key) == 0) ledHoldKey[0] = '\0';
}

// ---------- camera ----------
static bool initCamera(framesize_t size) {
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM; c.pin_d1 = Y3_GPIO_NUM; c.pin_d2 = Y4_GPIO_NUM; c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM; c.pin_d5 = Y7_GPIO_NUM; c.pin_d6 = Y8_GPIO_NUM; c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM; c.pin_pclk = PCLK_GPIO_NUM; c.pin_vsync = VSYNC_GPIO_NUM; c.pin_href = HREF_GPIO_NUM;
  c.pin_sccb_sda = SIOD_GPIO_NUM; c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.pin_pwdn = PWDN_GPIO_NUM; c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_JPEG;
  c.frame_size = size;
  c.jpeg_quality = 10;  // fixed quality, so JPEG size works as a sharpness proxy
  c.fb_count = 2;
  c.fb_location = CAMERA_FB_IN_PSRAM;
  c.grab_mode = CAMERA_GRAB_LATEST;
  return esp_camera_init(&c) == ESP_OK;
}

static bool setupCamera() {
  if (!psramFound()) {
    Serial.println("PSRAM not found: enable Tools > PSRAM > OPI PSRAM");
    return false;
  }
  if (!initCamera(FRAMESIZE_UXGA)) return false;
  sensor_t *s = esp_camera_sensor_get();
  uint16_t pid = s->id.PID;
  Serial.printf("Camera sensor PID 0x%04x\n", pid);
  if (pid == OV5640_PID || pid == OV3660_PID) {
    esp_camera_deinit();
    if (!initCamera(FRAMESIZE_QXGA)) return false;
    s = esp_camera_sensor_get();
  }
  s->set_sharpness(s, 2);
  s->set_contrast(s, 1);
#ifdef USE_OV5640_AF
  if (pid == OV5640_PID) {
    ov5640.start(s);
    if (ov5640.focusInit() == 0 && ov5640.autoFocusMode() == 0) Serial.println("OV5640 autofocus on");
  }
#endif
  return true;
}

static void newKey(char *out) {
  static const char hex[] = "0123456789abcdef";
  for (int i = 0; i < 32; i++) out[i] = hex[esp_random() & 0xF];
  out[32] = '\0';
}

static void freeCapture(Capture &c) {
  for (int i = 0; i < c.nFrames; i++) free(c.frames[i].buf);
  c.nFrames = 0;
}

// Takes n frames over about BURST_MS, keeps the best K in a new queue entry.
static void capturePress(int n, bool append, const char *mode) {
  lastActivityMs = millis();
  if (pendingCount >= MAX_PENDING) {
    play(led::queue_full);
    return;
  }
  busyCount++;
  applyOutputs();               // LED on now
  delay(PRE_CAPTURE_LED_MS);    // and for at least 500 ms before the sensor is read

  // Drop buffered frames so exposure reflects what is in view now.
  for (int i = 0; i < 2; i++) {
    camera_fb_t *old = esp_camera_fb_get();
    if (old) esp_camera_fb_return(old);
  }
  uint8_t *bufs[MAX_FRAMES] = {nullptr};
  size_t sizes[MAX_FRAMES] = {0};
  uint16_t ws[MAX_FRAMES] = {0}, hs[MAX_FRAMES] = {0};
  int got = 0;
  uint32_t interval = n > 1 ? BURST_MS / n : 0;
  for (int i = 0; i < n && i < MAX_FRAMES; i++) {
    uint32_t t0 = millis();
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) continue;
    uint8_t *copy = (uint8_t *)ps_malloc(fb->len);
    if (copy) {
      memcpy(copy, fb->buf, fb->len);
      bufs[got] = copy;
      sizes[got] = fb->len;
      ws[got] = fb->width;
      hs[got] = fb->height;
      got++;
    }
    esp_camera_fb_return(fb);
    uint32_t spent = millis() - t0;
    if (i + 1 < n && spent < interval) delay(interval - spent);
  }
  if (got == 0) {
    Serial.println("Capture failed");
    busyCount--;
    play(led::error);
    buzz(motor::error);
    return;
  }
  int keepIdx[MAX_KEEP];
  float keepScore[MAX_KEEP];
  int k = (strcmp(mode, "single") == 0) ? 1 : cfg.keepBest;
  int m = selectBest(sizes, got, k, RELATIVE_FLOOR_PCT, keepIdx, keepScore);

  Capture &c = pending[pendingCount];
  memset(&c, 0, sizeof(c));
  for (int j = 0; j < m; j++) {
    int i = keepIdx[j];
    c.frames[j] = {bufs[i], sizes[i], ws[i], hs[i], keepScore[j]};
    bufs[i] = nullptr;  // ownership moved to the queue
  }
  for (int i = 0; i < got; i++) free(bufs[i]);  // frees the ones not kept
  c.nFrames = m;
  newKey(c.key);
  strncpy(c.mode, mode, sizeof(c.mode) - 1);
  c.append = append;
  c.createdMs = millis();
  c.nextTryMs = millis();
  c.capturedAt = time(nullptr);
  pendingCount++;
  Serial.printf("Press %s: %d frames taken, %d kept\n", c.key, got, m);

  strncpy(ledHoldKey, c.key, sizeof(ledHoldKey));
  ledHoldUntil = millis() + UPLOAD_LED_HOLD_MS;
  busyCount--;
  buzz(motor::captured);
}

static void dropPending(int i) {
  freeCapture(pending[i]);
  for (int j = i; j < pendingCount - 1; j++) pending[j] = pending[j + 1];
  pendingCount--;
}

// ---------- HTTP ----------
static bool beginHttp(HTTPClient &http, WiFiClient &plain, WiFiClientSecure &secure, const String &url) {
  if (url.startsWith("https://")) {
    secure.setCACert(ROOT_CA_PEM);
    return http.begin(secure, url);
  }
  return http.begin(plain, url);
}

static void addAuth(HTTPClient &http) {
  http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
  http.addHeader("X-Device-Id", DEVICE_ID);
}

static void isoTime(time_t t, char *out, size_t n) {
  struct tm tmv;
  gmtime_r(&t, &tmv);
  strftime(out, n, "%Y-%m-%dT%H:%M:%S.000Z", &tmv);
}

// Builds the multipart body in PSRAM. Caller frees *out.
static bool buildBody(const Capture &c, const char *boundary, uint8_t **out, size_t *outLen) {
  char meta[768];
  char when[32];
  isoTime(c.capturedAt, when, sizeof when);
  int pos = snprintf(meta, sizeof meta, "{\"mode\":\"%s\",\"capturedAt\":\"%s\"", c.mode, when);
  const char *target = appendTarget(c.append, lastJobId, lastPressDropped);
  if (target) {
    pos += snprintf(meta + pos, sizeof meta - pos, ",\"appendTo\":\"%s\"", target);
  }
  pos += snprintf(meta + pos, sizeof meta - pos, ",\"frames\":[");
  for (int i = 0; i < c.nFrames; i++) {
    pos += snprintf(meta + pos, sizeof meta - pos, "%s{\"name\":\"frame%d\",\"score\":%.3f,\"width\":%u,\"height\":%u}",
                    i ? "," : "", i, c.frames[i].score, c.frames[i].w, c.frames[i].h);
  }
  pos += snprintf(meta + pos, sizeof meta - pos, "]}");
  if (pos <= 0 || pos >= (int)sizeof meta) return false;

  size_t total = 0;
  char head[200];
  total += snprintf(head, sizeof head,
                    "--%s\r\nContent-Disposition: form-data; name=\"meta\"\r\nContent-Type: application/json\r\n\r\n",
                    boundary) + pos + 2;
  for (int i = 0; i < c.nFrames; i++) {
    total += snprintf(head, sizeof head,
                      "--%s\r\nContent-Disposition: form-data; name=\"frame%d\"; filename=\"frame%d.jpg\"\r\n"
                      "Content-Type: image/jpeg\r\n\r\n", boundary, i, i) + c.frames[i].len + 2;
  }
  total += strlen(boundary) + 6;
  uint8_t *buf = (uint8_t *)ps_malloc(total + 1);
  if (!buf) return false;
  size_t o = 0;
  o += snprintf((char *)buf + o, total + 1 - o,
               "--%s\r\nContent-Disposition: form-data; name=\"meta\"\r\nContent-Type: application/json\r\n\r\n",
               boundary);
  memcpy(buf + o, meta, pos); o += pos;
  memcpy(buf + o, "\r\n", 2); o += 2;
  for (int i = 0; i < c.nFrames; i++) {
    o += snprintf((char *)buf + o, total + 1 - o,
                 "--%s\r\nContent-Disposition: form-data; name=\"frame%d\"; filename=\"frame%d.jpg\"\r\n"
                 "Content-Type: image/jpeg\r\n\r\n", boundary, i, i);
    memcpy(buf + o, c.frames[i].buf, c.frames[i].len); o += c.frames[i].len;
    memcpy(buf + o, "\r\n", 2); o += 2;
  }
  o += snprintf((char *)buf + o, total + 1 - o, "--%s--\r\n", boundary);
  *out = buf;
  *outLen = o;
  return true;
}

static void startPoll(const char *jobId) {
  if (cfg.pollSeconds == 0) return;
  strncpy(poll.jobId, jobId, sizeof(poll.jobId) - 1);
  poll.jobId[sizeof(poll.jobId) - 1] = '\0';
  uint32_t forMs = (uint32_t)cfg.pollSeconds * 1000UL;
  poll.untilMs = millis() + (forMs < POLL_FOR_MS ? forMs : POLL_FOR_MS);
  poll.nextMs = millis() + POLL_EVERY_MS;
  poll.active = true;
}

static void signalStatus(const char *status) {
  if (strcmp(status, "retake") == 0) { play(led::retake); buzz(motor::retake); }
  else if (strcmp(status, "ready") == 0) { play(led::ready); buzz(motor::ready); }
  else if (strcmp(status, "failed") == 0) { play(led::error); buzz(motor::error); }
}

static void serviceQueue() {
  uint32_t now = millis();
  for (int i = pendingCount - 1; i >= 0; i--) {
    if (now - pending[i].createdMs > MAX_AGE_MS) {
      lastPressDropped = true;
      releaseHold(pending[i].key);
      dropPending(i);
      play(led::error);
    }
  }
  if (pendingCount == 0) return;
  Capture &c = pending[0];
  if ((int32_t)(now - c.nextTryMs) < 0) return;
  int code = -1;
  String resp;
  if (WiFi.status() == WL_CONNECTED) {
    char boundary[40];
    snprintf(boundary, sizeof boundary, "----evencam%08lx", (unsigned long)esp_random());
    uint8_t *body = nullptr;
    size_t len = 0;
    if (buildBody(c, boundary, &body, &len)) {
      HTTPClient http;
      WiFiClient plain;
      WiFiClientSecure secure;
      if (beginHttp(http, plain, secure, String(SERVER_URL) + "/v1/captures")) {
        http.setTimeout(HTTP_TIMEOUT_MS);
        http.setConnectTimeout(10000);
        addAuth(http);
        http.addHeader("Idempotency-Key", c.key);
        http.addHeader("Content-Type", String("multipart/form-data; boundary=") + boundary);
        code = http.POST(body, len);
        if (code > 0) resp = http.getString();
        http.end();
      }
      free(body);
    } else {
      Serial.println("Out of PSRAM building upload");
    }
  }
  c.attempts++;
  releaseHold(c.key);  // the first attempt is over: the solid LED can go
  char jobId[48] = "";
  Outcome o = uploadOutcome(code, resp.c_str(), jobId, sizeof jobId);
  Serial.printf("Upload %s attempt %u -> %d\n", c.key, c.attempts, code);
  if (o == Outcome::Ok) {
    char status[16] = "";
    strncpy(lastJobId, jobId, sizeof(lastJobId) - 1);
    lastPressDropped = false;
    jsonString(resp.c_str(), "status", status, sizeof status);
    play(led::uploaded);
    if (!strcmp(status, "ready") || !strcmp(status, "retake") || !strcmp(status, "failed")) {
      signalStatus(status);
    } else {
      startPoll(jobId);
    }
    dropPending(0);
  } else if (o == Outcome::Drop) {
    lastPressDropped = true;
    dropPending(0);
    play(led::error);
    buzz(motor::error);
  } else {
    if (!c.notifiedOffline) {
      c.notifiedOffline = true;
      play(led::queued_offline);
    }
    c.nextTryMs = millis() + backoffMs(c.attempts, esp_random());
  }
  lastActivityMs = millis();
}

static void servicePoll() {
  if (!poll.active) return;
  uint32_t now = millis();
  if ((int32_t)(now - poll.untilMs) > 0) { poll.active = false; return; }
  if ((int32_t)(now - poll.nextMs) < 0 || WiFi.status() != WL_CONNECTED) return;
  poll.nextMs = now + POLL_EVERY_MS;
  HTTPClient http;
  WiFiClient plain;
  WiFiClientSecure secure;
  if (!beginHttp(http, plain, secure, String(SERVER_URL) + "/v1/captures/" + poll.jobId)) return;
  http.setTimeout(10000);
  addAuth(http);
  int code = http.GET();
  String body = code > 0 ? http.getString() : String();
  http.end();
  if (code == 200) {
    char status[16];
    if (jsonString(body.c_str(), "status", status, sizeof status) &&
        (!strcmp(status, "ready") || !strcmp(status, "retake") || !strcmp(status, "failed"))) {
      poll.active = false;
      signalStatus(status);
    }
  } else if (classify(code) == Outcome::Drop) {
    poll.active = false;
  }
  lastActivityMs = millis();
}

static void fetchConfig() {
  HTTPClient http;
  WiFiClient plain;
  WiFiClientSecure secure;
  if (!beginHttp(http, plain, secure, String(SERVER_URL) + "/v1/camera/config")) return;
  http.setTimeout(10000);
  addAuth(http);
  int code = http.GET();
  if (code == 200) {
    String b = http.getString();
    const char *j = b.c_str();
    // Only capture tuning is read. Nothing here can touch the LED or start a capture.
    cfg.burstFrames = (uint8_t)clampLong(jsonInt(j, "burstFrames", 4), 1, MAX_FRAMES);
    cfg.keepBest = (uint8_t)clampLong(jsonInt(j, "uploadFrames", 3), 1, MAX_KEEP);
    if (cfg.keepBest > cfg.burstFrames) cfg.keepBest = cfg.burstFrames;
    cfg.longBurstFrames = (uint8_t)clampLong(jsonInt(j, "longBurstFrames", 8), 2, MAX_FRAMES);
    char mode[12];
    cfg.singleMode = jsonString(j, "defaultMode", mode, sizeof mode) && strcmp(mode, "single") == 0;
    cfg.pollSeconds = (uint8_t)clampLong(jsonInt(j, "statusPollSeconds", 30), 0, 60);
    cfg.loaded = true;
    Serial.printf("Config: N=%u K=%u long=%u %s\n", cfg.burstFrames, cfg.keepBest, cfg.longBurstFrames,
                  cfg.singleMode ? "single" : "burst");
  }
  http.end();
}

static void handleEvent(Event e) {
  switch (e) {
    case Event::Single:
      capturePress(cfg.singleMode ? 1 : cfg.burstFrames, false, cfg.singleMode ? "single" : "burst");
      break;
    case Event::Double:
      capturePress(cfg.singleMode ? 1 : cfg.burstFrames, true, cfg.singleMode ? "single" : "burst");
      break;
    case Event::Long:
      capturePress(cfg.longBurstFrames, false, "burst");
      break;
    case Event::Stuck:
      play(led::stuck);
      break;
    default:
      break;
  }
  // Samples were missed during capture: start the button fresh.
  grammar.reset(digitalRead(BUTTON_PIN) == LOW, millis());
}

// ---------- sleep ----------
static bool canSleep() {
  return pendingCount == 0 && !poll.active && !grammar.busy() && ledPlayer.idle() && motorPlayer.idle() &&
         busyCount == 0 && millis() - lastActivityMs > STAY_AWAKE_MS;
}

static void goToSleep() {
  Serial.println("Deep sleep; press the button to wake");
  while (digitalRead(BUTTON_PIN) == LOW) delay(10);  // would wake at once otherwise
  digitalWrite(LED_PIN, LOW);
#ifdef MOTOR_PIN
  digitalWrite(MOTOR_PIN, LOW);
#endif
  esp_camera_deinit();
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  rtc_gpio_pullup_en((gpio_num_t)BUTTON_PIN);
  rtc_gpio_pulldown_dis((gpio_num_t)BUTTON_PIN);
  esp_sleep_enable_ext0_wakeup((gpio_num_t)BUTTON_PIN, 0);  // GPIO2 is RTC-capable (ASSUMPTION: check datasheet)
  esp_deep_sleep_start();
}

// When the button woke the board, read that press before the slow camera start.
static Event readWakePress() {
  Event ev[2];
  uint32_t start = millis();
  // A quick tap may be over before the CPU runs this. It still woke the board, so it
  // counts as a single press. ASSUMPTION: wake-up takes well under a tap's length.
  if (digitalRead(BUTTON_PIN) == HIGH) {
    grammar.reset(false, start);
    return Event::Single;
  }
  grammar.update(false, start - 50, ev);  // armed: the press that woke us counts
  while (millis() - start < 2000) {
    int n = grammar.update(digitalRead(BUTTON_PIN) == LOW, millis(), ev);
    if (n > 0) return ev[0];  // a "single" followed by "long" cannot happen in 2 s from rest
    delay(5);
  }
  return Event::None;
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
#ifdef MOTOR_PIN
  pinMode(MOTOR_PIN, OUTPUT);
  digitalWrite(MOTOR_PIN, LOW);
#endif
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  rtc_gpio_deinit((gpio_num_t)BUTTON_PIN);
  pinMode(BUTTON_PIN, INPUT_PULLUP);

  bool wokeByButton = esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_EXT0;
  Event wakeEvent = wokeByButton ? readWakePress() : Event::None;
  if (!wokeByButton) grammar.reset(digitalRead(BUTTON_PIN) == LOW, millis());

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(true);
  wifiMulti.addAP(WIFI_SSID_1, WIFI_PASS_1);
  if (strlen(WIFI_SSID_2) > 0) wifiMulti.addAP(WIFI_SSID_2, WIFI_PASS_2);

  if (!setupCamera()) {
    Serial.println("Camera init failed");
    while (true) {
      digitalWrite(LED_PIN, HIGH); delay(100);
      digitalWrite(LED_PIN, LOW); delay(900);
    }
  }
  lastActivityMs = millis();
  if (!wokeByButton) play(led::boot);
  if (wakeEvent != Event::None) handleEvent(wakeEvent);
  Serial.println("Ready");
}

void loop() {
  static uint32_t lastWifiCheck = 0;
  static uint32_t lastConfigTry = 0;
  uint32_t now = millis();
  if (now - lastWifiCheck > 1000 || lastWifiCheck == 0) {
    lastWifiCheck = now;
    wifiMulti.run(5000);
    if (WiFi.status() == WL_CONNECTED && !timeSynced) {
      configTime(0, 0, "pool.ntp.org", "time.google.com");
      timeSynced = true;
    }
  }
  if (WiFi.status() == WL_CONNECTED && (now - lastConfigTry > 300000UL || lastConfigTry == 0)) {
    lastConfigTry = now;
    fetchConfig();
  }
  Event ev[2];
  int n = grammar.update(digitalRead(BUTTON_PIN) == LOW, millis(), ev);
  for (int i = 0; i < n; i++) handleEvent(ev[i]);
  serviceQueue();
  servicePoll();
  applyOutputs();
  if (canSleep()) goToSleep();
  delay(5);
}
