// Host tests for camera/esp32/even_cam/logic.h. No board needed.
//   camera/esp32/test/run.sh
#include <cstdio>
#include <random>
#include <string>
#include <vector>

#include "../even_cam/logic.h"

using namespace evencam;

static int failures = 0, checks = 0;
#define CHECK(cond)                                                          \
  do {                                                                       \
    checks++;                                                                \
    if (!(cond)) {                                                           \
      failures++;                                                            \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);            \
    }                                                                        \
  } while (0)

struct Seg {
  bool pressed;
  uint32_t ms;
};

static std::string run(const std::vector<Seg> &segs, ButtonTiming t = ButtonTiming(), bool startPressed = false,
                       uint32_t step = 5) {
  ButtonGrammar g(t);
  uint32_t now = 1000;
  Event ev[2];
  g.update(startPressed, now, ev);
  std::string out;
  std::vector<Seg> all = segs;
  all.push_back({false, 1000});
  for (const Seg &s : all) {
    uint32_t end = now + s.ms;
    while (now < end) {
      now += step;
      int n = g.update(s.pressed, now, ev);
      for (int i = 0; i < n; i++) {
        if (!out.empty()) out += ",";
        switch (ev[i]) {
          case Event::Single: out += "single"; break;
          case Event::Double: out += "double"; break;
          case Event::Long: out += "long"; break;
          case Event::Stuck: out += "stuck"; break;
          default: out += "?"; break;
        }
      }
    }
  }
  return out;
}

static void testGrammar() {
  CHECK(run({{false, 100}, {true, 120}}) == "single");
  CHECK(run({{false, 100}, {true, 100}, {false, 150}, {true, 100}}) == "double");
  CHECK(run({{false, 100}, {true, 1500}}) == "long");
  CHECK(run({{false, 100}, {true, 1000}, {false, 100}, {true, 100}}) == "long,single");
  CHECK(run({{false, 100}, {true, 100}, {false, 100}, {true, 1200}}) == "single,long");
  CHECK(run({{false, 100}, {true, 80}, {false, 100}, {true, 80}, {false, 100}, {true, 80}}) == "double,single");
  CHECK(run({{false, 100}, {true, 100}, {false, 600}, {true, 100}}) == "single,single");
  CHECK(run({{false, 100}, {true, 780}}) == "single");
  CHECK(run({{false, 100}, {true, 830}}) == "long");
  CHECK(run({{false, 100}, {true, 100}, {false, 330}, {true, 100}}) == "double");
  CHECK(run({{false, 100}, {true, 100}, {false, 380}, {true, 100}}) == "single,single");
  CHECK(run({{false, 100}, {true, 15}, {false, 500}}).empty());
  CHECK(run({{true, 2000}, {false, 200}, {true, 100}}, ButtonTiming(), true) == "single");
  CHECK(run({{false, 100}, {true, 16000}}, ButtonTiming(), false, 10) == "long,stuck");
  CHECK(run({{false, 5000}}).empty());
  // bounce at both edges
  CHECK(run({{false, 100}, {true, 4}, {false, 4}, {true, 4}, {false, 4}, {true, 120}, {false, 4}, {true, 4},
             {false, 600}}) == "single");
  // millis() wrap-around: start just before 2^32
  {
    ButtonGrammar g;
    Event ev[2];
    uint32_t now = 0xFFFFFF00u;
    g.update(false, now, ev);
    std::string out;
    for (int i = 0; i < 40; i++) { now += 5; int n = g.update(true, now, ev); if (n) out += "x"; }
    for (int i = 0; i < 200; i++) {
      now += 5;
      int n = g.update(false, now, ev);
      for (int j = 0; j < n; j++) out += ev[j] == Event::Single ? "single" : "other";
    }
    CHECK(out == "single");
  }
  // randomised: bounce shorter than debounce never changes the result
  std::mt19937 rng(42);
  int mismatches = 0;
  for (int trial = 0; trial < 300; trial++) {
    std::vector<Seg> clean = {{false, 100}};
    int presses = 1 + rng() % 4;
    const uint32_t holds[] = {60, 120, 300, 600, 1000, 1400};
    const uint32_t gaps[] = {100, 200, 500, 900};
    for (int i = 0; i < presses; i++) {
      clean.push_back({true, holds[rng() % 6]});
      clean.push_back({false, gaps[rng() % 4]});
    }
    std::vector<Seg> noisy;
    for (const Seg &s : clean) {
      int flips = rng() % 4;
      uint32_t each = 2 + rng() % 5;
      uint32_t used = 0;
      for (int f = 0; f < flips; f++) {
        noisy.push_back({f % 2 == 0 ? !s.pressed : s.pressed, each});
        used += each;
      }
      noisy.push_back({s.pressed, s.ms > used + 10 ? s.ms - used : 10});
    }
    if (run(noisy) != run(clean)) mismatches++;
  }
  CHECK(mismatches == 0);
}

static void testPatterns() {
  PatternPlayer p;
  p.play(led::uploaded, 0);
  int edges = 0;
  bool last = false;
  for (uint32_t t = 0; t < 1000; t += 10) {
    bool l = p.level(t);
    if (l && !last) edges++;
    last = l;
  }
  CHECK(edges == 2);
  CHECK(p.idle());
  p.play(led::uploaded, 2000);
  p.play(led::ready, 2000);
  edges = 0;
  last = false;
  for (uint32_t t = 2000; t < 4000; t += 10) {
    bool l = p.level(t);
    if (l && !last) edges++;
    last = l;
  }
  CHECK(edges == 3);
  CHECK(p.idle());
  CHECK(!p.level(5000));
}

static void testSelection() {
  size_t sizes[] = {100000, 300000, 250000, 60000};
  int idx[3];
  float sc[3];
  int m = selectBest(sizes, 4, 3, 35, idx, sc);
  CHECK(m == 2 || m == 3);
  CHECK(idx[0] == 1 && idx[1] == 2);
  CHECK(sc[0] == 1.0f);
  CHECK(m == 2);  // 100000/300000 = 33 % < 35 % floor
  size_t one[] = {5};
  CHECK(selectBest(one, 1, 3, 35, idx, sc) == 1 && idx[0] == 0);
  size_t zeros[] = {0, 0};
  CHECK(selectBest(zeros, 2, 3, 35, idx, sc) == 1);  // never empty
  CHECK(selectBest(sizes, 0, 3, 35, idx, sc) == 0);
  size_t eight[] = {9, 8, 7, 10, 6, 5, 4, 3};
  CHECK(selectBest(eight, 8, 3, 35, idx, sc) == 3 && idx[0] == 3 && idx[1] == 0 && idx[2] == 1);
}

static void testBackoffAndClassify() {
  CHECK(backoffMs(1, 0) == 2000);
  CHECK(backoffMs(2, 0) == 4000);
  CHECK(backoffMs(6, 0) == 60000);
  CHECK(backoffMs(20, 0) == 60000);
  CHECK(backoffMs(1, 1234) == 2234);
  CHECK(classify(202) == Outcome::Ok);
  CHECK(classify(200) == Outcome::Ok);
  CHECK(classify(401) == Outcome::Drop);
  CHECK(classify(413) == Outcome::Drop);
  CHECK(classify(429) == Outcome::Retry);
  CHECK(classify(408) == Outcome::Retry);
  CHECK(classify(503) == Outcome::Retry);
  CHECK(classify(-1) == Outcome::Retry);
}

static void testJson() {
  const char *j = "{\"jobId\": \"a1b2-c3\",\"status\":\"retake\",\"retakeReason\":\"too dark\",\"burstFrames\":6,\"keepBest\": 2}";
  char buf[40];
  CHECK(jsonString(j, "jobId", buf, sizeof buf) && std::string(buf) == "a1b2-c3");
  CHECK(jsonString(j, "status", buf, sizeof buf) && std::string(buf) == "retake");
  CHECK(!jsonString(j, "missing", buf, sizeof buf));
  CHECK(!jsonString(j, "burstFrames", buf, sizeof buf));
  char tiny[4];
  CHECK(!jsonString(j, "jobId", tiny, sizeof tiny));  // too long for buffer
  CHECK(jsonInt(j, "burstFrames", 4) == 6);
  CHECK(jsonInt(j, "keepBest", 3) == 2);
  CHECK(jsonInt(j, "status", 7) == 7);
  CHECK(jsonInt(nullptr, "x", 9) == 9);
  CHECK(clampLong(99, 1, 8) == 8 && clampLong(-3, 1, 8) == 1);
}

// A gap in sampling (capture, Wi-Fi) must not lose the first of two presses.
static void testSampleGap() {
  ButtonGrammar g;
  Event ev[2];
  std::vector<Event> got;
  const std::pair<bool, uint32_t> samples[] = {{false, 1000}, {true, 1010}, {true, 1050}, {false, 1150}, {false, 1190},
                                               {true, 1600}, {true, 1640}, {false, 1700}, {false, 1740}, {false, 2200}};
  for (const auto &s : samples) {
    int n = g.update(s.first, s.second, ev);
    for (int i = 0; i < n; i++) got.push_back(ev[i]);
  }
  CHECK(got.size() == 2 && got[0] == Event::Single && got[1] == Event::Single);
}

// A 2xx that names no job (captive portal, wrong proxy) is not an upload.
static void testUploadOutcome() {
  char id[48];
  CHECK(uploadOutcome(202, "{\"jobId\":\"abc-1\",\"status\":\"queued\"}", id, sizeof id) == Outcome::Ok);
  CHECK(strcmp(id, "abc-1") == 0);
  CHECK(uploadOutcome(200, "<html>Login to Wi-Fi</html>", id, sizeof id) == Outcome::Retry);
  CHECK(uploadOutcome(202, "{\"jobId\":\"\"}", id, sizeof id) == Outcome::Retry);
  CHECK(uploadOutcome(202, nullptr, id, sizeof id) == Outcome::Retry);
  CHECK(uploadOutcome(400, "{}", id, sizeof id) == Outcome::Drop);
  CHECK(uploadOutcome(503, "{}", id, sizeof id) == Outcome::Retry);
  // A double press whose first press was given up on goes out as a new question.
  CHECK(strcmp(appendTarget(true, "job-7", false), "job-7") == 0);
  CHECK(strcmp(appendTarget(true, "", false), "previous") == 0);
  CHECK(appendTarget(true, "job-7", true) == nullptr);
  CHECK(appendTarget(false, "job-7", false) == nullptr);
}

int main() {
  testGrammar();
  testUploadOutcome();
  testSampleGap();
  testPatterns();
  testSelection();
  testBackoffAndClassify();
  testJson();
  std::printf("%d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
