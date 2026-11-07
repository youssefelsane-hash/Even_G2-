// Random event storms through the real Assistant and RenderQueue with a slow,
// failing display. Unlike the Rig plan list, this checks what the lens itself got.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Assistant } from '../src/core/assistant.ts';
import { BLANK_TEXT, RenderQueue, type DisplayPort } from '../src/core/renderQueue.ts';
import { MemoryStore } from '../src/core/storage.ts';
import { mulberry32, shake, still, stream, tilt } from '../src/core/synth.ts';

class Lens implements DisplayPort {
  shown = 'old content from before the restart';
  fail = false;
  slow = false;
  lateHidden = 0;
  a: Assistant | null = null;
  private push(text: string): Promise<boolean> {
    // At the moment of sending, content is allowed only if the app is in a showing state.
    if (text !== BLANK_TEXT && this.a && ['HIDDEN', 'REMOVED'].includes(this.a.state)) this.lateHidden++;
    if (this.fail) return Promise.resolve(false);
    return new Promise((res) => {
      const done = () => { this.shown = text; res(true); };
      if (this.slow) setTimeout(done, 0); else done();
    });
  }
  setText(t: string): Promise<boolean> { return this.push(t); }
  rebuild(t: string): Promise<boolean> { return this.push(t); }
}

for (let seed = 1; seed <= 30; seed++) {
  test(`hidden means a dark lens, whatever happens (seed ${seed})`, async () => {
    const rng = mulberry32(seed);
    const lens = new Lens();
    const q = new RenderQueue(lens, 50);
    let time = 1_000_000;
    const store = new MemoryStore();
    const a = await Assistant.create({
      store, now: () => time,
      onPlan: (p, force) => void q.show(p, force),
    });
    lens.a = a;
    void q.show(a.plan());
    const settings = a.settings;
    const feed = (m: Parameters<typeof stream>[0]) => {
      const start = time;
      for (const s of stream(m, { settings })) {
        time = start + s.t;
        a.handleImu({ ...s, t: time });
      }
    };
    const answer = { id: 'x', short: 'secret answer', details: 'more secret detail\n'.repeat(30) };
    const actions: (() => void)[] = [
      () => a.handleWear(true), () => a.handleWear(false), () => a.handleWear(undefined),
      () => a.handleConnection(true), () => a.handleConnection(false),
      () => a.handleForeground(), () => a.handleExit(),
      () => a.aiStarted(), () => a.aiResult(answer), () => a.aiError('secret error'),
      () => a.handleTouch('press'), () => { for (let i = 0; i < 4; i++) a.handleTouch('press'); },
      () => a.handleTouch('double'), () => a.handleTouch('swipeDown'), () => a.handleTouch('swipeUp'),
      () => feed(still(600)), () => feed(shake()), () => feed(tilt(-24, { holdMs: 600 })),
      () => { time += 2000; }, () => { time += 20_000; }, () => { time -= 5000; },
      () => { lens.fail = rng() < 0.3; lens.slow = rng() < 0.5; },
      () => void a.tick(),
    ];
    for (let i = 0; i < 300; i++) {
      actions[Math.floor(rng() * actions.length)]();
      if (rng() < 0.25) await new Promise((r) => setTimeout(r, 0));
      if (rng() < 0.3) {
        lens.fail = false;
        void q.show(a.plan()); // the one-second timer in main.ts
        await new Promise((r) => setTimeout(r, 1));
        await new Promise((r) => setTimeout(r, 1));
        if (a.state === 'HIDDEN' || a.state === 'REMOVED') {
          assert.equal(lens.shown, BLANK_TEXT, `step ${i}: the lens shows "${lens.shown.slice(0, 30)}" in ${a.state}`);
        }
      }
    }
    assert.equal(lens.lateHidden, 0, 'content was sent while hidden');
    // Never trapped: once worn and connected, one deliberate action brings the app back.
    a.handleConnection(true);
    a.handleWear(false);
    a.handleWear(true);
    time += a.settings.wearSettleMs + 1;
    if (a.state === 'HIDDEN') for (let i = 0; i < 4; i++) a.handleTouch('press');
    assert.notEqual(a.state, 'HIDDEN');
    assert.notEqual(a.state, 'REMOVED');
  });
}
