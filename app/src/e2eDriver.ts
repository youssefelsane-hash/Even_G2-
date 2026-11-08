import { STATE_KEY, clearBackendSettings } from './core/backend.ts';
import { scenario } from './core/scenarios.ts';
import { sequence, still } from './core/synth.ts';
import { playMotion } from './motionPlayer.ts';
import type { PanelHost } from './panel.ts';

// Development only (?e2e=<control origin>). Used by tools/e2e-system/run.mjs.
// The simulator has no IMU and no wear events, and its automation API cannot
// reach the app, so the full-system test sends commands over a small local
// control server: put the glasses on or off, play a synthetic shake, press,
// reload. Each reply carries the app state and the text the lens would show,
// so the driver can check it next to the real framebuffer screenshot.
// Never part of a production build: main.ts imports it only when DEV is true.

interface Command { id: number; cmd: string; args?: Record<string, unknown> }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runE2eDriver(host: PanelHost, ctl: string): Promise<void> {
  const { assistant, client, now } = host;
  const report = () => {
    const plan = assistant.plan();
    return {
      snapshot: assistant.snapshot(),
      docId: assistant.docId,
      lens: plan.kind === 'text' ? plan.text : '',
      conn: client.connState,
      cursor: client.cursor,
      presenceSent: client.presence,
      polls: client.polls,
    };
  };
  const post = async (path: string, body: unknown) => {
    try {
      await fetch(`${ctl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
    } catch { /* the driver may be gone */ }
  };

  const run = async (c: Command): Promise<unknown> => {
    const a = c.args ?? {};
    switch (c.cmd) {
      case 'connect':
        assistant.handleConnection(a.on !== false);
        return report();
      case 'wear':
        assistant.handleWear(a.on === true);
        if (a.on === true) await sleep(assistant.settings.wearSettleMs + 200);
        return report();
      case 'motion': {
        await playMotion(assistant, sequence(still(1200), scenario(String(a.name ?? 'shake')).motion(1)), now);
        await sleep(300);
        return report();
      }
      case 'touch':
        assistant.handleTouch((a.kind as 'press' | 'double' | 'swipeUp' | 'swipeDown') ?? 'press');
        return report();
      case 'state':
        return report();
      case 'forget':
        // End of a run: the WebView storage outlives the simulator, so leave no
        // test server address, token or cursor behind for the next session.
        await client.stop();
        clearBackendSettings(host.kv);
        try { host.kv.setItem(STATE_KEY, 'null'); } catch { /* nothing stored */ }
        return report();
      case 'reload':
        await assistant.flush();
        setTimeout(() => location.reload(), 300);
        return report();
      default:
        throw new Error(`unknown command ${c.cmd}`);
    }
  };

  await post('/hello', report());
  for (;;) {
    let c: Command | null = null;
    try {
      const res = await fetch(`${ctl}/cmd`, { cache: 'no-store' });
      if (res.status === 200) c = (await res.json()) as Command;
    } catch {
      await sleep(500);
      continue;
    }
    if (!c) { await sleep(100); continue; }
    try {
      await post('/done', { id: c.id, ok: true, result: await run(c) });
    } catch (e) {
      await post('/done', { id: c.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
}
