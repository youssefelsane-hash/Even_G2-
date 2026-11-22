import { waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk';
import { getTextWidth } from '@evenrealities/pretext';
import './style.css';
import { Assistant } from './core/assistant.ts';
import { ResultClient, loadBackendSettings, saveBackendSettings, type SyncKV } from './core/backend.ts';
import { BridgeLane, BridgeStore } from './core/bridgeLane.ts';
import { RenderQueue, type DisplayPlan, type DisplayPort } from './core/renderQueue.ts';
import { MemoryStore } from './core/storage.ts';
import { GlassesPort } from './glasses.ts';
import { HostLink } from './hostLink.ts';
import { initPanel, type PanelHost } from './panel.ts';
import { appNow } from './devClock.ts';

const LOG_TAIL_KEY = 'g2a.log.tail';
const BOOTS_KEY = 'g2a.boots';
const LOG_TAIL_ROWS = 3000;
const APP_REVISION = 'wear-poll-4';

// Wall clock on purpose (see devClock.ts): if the WebView is suspended, Date.now jumps forward and
// the time gap shows up in the log. A monotonic page clock might simply pause.
const now = appNow;

function connectBridge(timeoutMs: number): Promise<EvenAppBridge | null> {
  return Promise.race([
    waitForEvenAppBridge().catch(() => null),
    new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
  ]);
}

function localGet(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function localSet(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* blocked or full: logging only */ }
}

// The backend cursor and token live in the WebView's localStorage, which the
// Even Hub docs say survives a reload. Answers live in the host store instead.
const localKv: SyncKV = { getItem: localGet, setItem: (k, v) => window.localStorage.setItem(k, v) };

// Each boot is recorded so Phase 0 can count how often the WebView restarts.
function recordBoot(): number[] {
  let boots: number[] = [];
  try { boots = JSON.parse(localGet(BOOTS_KEY) ?? '[]') as number[]; } catch { boots = []; }
  boots = [...boots, now()].slice(-50);
  localSet(BOOTS_KEY, JSON.stringify(boots));
  return boots;
}

async function main(): Promise<void> {
  const boots = recordBoot();
  const previousLog = localGet(LOG_TAIL_KEY);
  const params = new URLSearchParams(location.search);
  const scriptedSimulation = import.meta.env.DEV && (params.has('autopilot') || !!params.get('e2e'));
  const bridge = await connectBridge(3000);
  const lane = new BridgeLane();
  const glasses = bridge ? new GlassesPort(bridge, lane) : null;
  // Before anything else: the page left by an earlier run may still show content.
  let pageReady = glasses ? await glasses.init() : false;
  if (bridge) console.log(pageReady ? 'APP_READY blank page created' : 'APP_ERROR could not create the glasses page');
  else console.log('APP_READY without glasses bridge');

  const port: DisplayPort = glasses ?? { setText: async () => true, rebuild: async () => true };
  const queue = new RenderQueue(port);
  let lastState = '';
  let refreshPanel = (): void => {};
  let assistantRef: Assistant | null = null;
  const client = new ResultClient({
    kv: localKv,
    fetch: (url, init) => fetch(url, init),
    // Results are held until the Assistant exists. It is created next, before polling starts.
    onEvent: (e) => assistantRef?.handleJobEvent(e),
    onState: (s, detail) => { console.log(`BACKEND ${s}${detail ? ` ${detail}` : ''}`); refreshPanel(); },
  });

  const assistant = await Assistant.create({
    store: bridge ? new BridgeStore(bridge, lane) : new MemoryStore(),
    initialSettings: scriptedSimulation ? { unlockGesture: 'either', tiltEnabled: true, trustWearSensor: true } : undefined,
    now,
    measure: getTextWidth,
    onPlan: (plan: DisplayPlan, force) => void queue.show(plan, force),
    onExitRequest: () => { if (bridge) void lane.run(() => bridge.shutDownPageContainer(1)).catch(() => false); },
    onDisplayed: (jobId) => client.ack(jobId, 'displayed'),
    onPresence: (mode) => client.setPresence(mode),
    onChange: () => {
      if (assistant.state !== lastState) {
        lastState = assistant.state;
        console.log(`STATE ${lastState}`);
      }
      refreshPanel();
    },
  });
  queue.onBlankFailed = () => console.error('APP_ERROR the lens could not be blanked');
  assistantRef = assistant;
  client.setPresence(assistant.snapshot().presence);
  // Development only: the full-system test (tools/e2e-system) passes a local test
  // server and a token generated for that run. Never compiled into a build.
  if (import.meta.env.DEV && params.has('e2e') && params.get('server') && params.get('token')) {
    const err = saveBackendSettings(localKv, { serverUrl: params.get('server') ?? '', token: params.get('token') ?? '' });
    if (err) console.error(`APP_ERROR e2e settings: ${err}`);
  }
  const backend = loadBackendSettings(localKv);
  if (backend) client.start(backend);
  window.addEventListener('online', () => client.wake());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') client.wake(); });

  const timers: ReturnType<typeof setInterval>[] = [];
  const link = bridge ? new HostLink({
    bridge,
    assistant,
    lane,
    now,
    onClosed: () => { timers.forEach(clearInterval); void client.stop(); },
    onForeground: () => client.wake(),
  }) : null;
  await link?.start(pageReady);

  // The first page call can fail on a real phone (slow Bluetooth, glasses still
  // waking). Without a page the IMU cannot start, so keep trying.
  let pageTry = 0;
  let pageBusy = false;
  const retryPage = (): void => {
    if (pageReady || pageBusy || !glasses || !link || ++pageTry % 3 !== 0) return;
    pageBusy = true;
    void glasses.init().then((ok) => {
      pageBusy = false;
      if (!ok || link.isClosed) return; // the app ended while this try was running
      pageReady = true;
      console.log('APP_READY glasses page created on retry');
      link.setPageReady();
      void queue.show(assistant.plan(), true);
      refreshPanel();
    });
  };

  timers.push(setInterval(() => {
    retryPage();
    void assistant.tick();
    void queue.show(assistant.plan()); // an unchanged plan costs nothing; a failed blank is retried here
  }, 1000));
  // Wear recovery must not wait for the one-second UI/backend maintenance tick.
  timers.push(setInterval(() => link?.tick(), 250));
  timers.push(setInterval(() => {
    if (assistant.logger.recording) localSet(LOG_TAIL_KEY, assistant.logger.toCsv(LOG_TAIL_ROWS));
  }, 5000));

  const host: PanelHost = {
    assistant, client, kv: localKv, previousLog, boots,
    revision: APP_REVISION,
    hasBridge: bridge !== null, pageReady: () => pageReady, now,
    simulateInput: import.meta.env.DEV && (scriptedSimulation || params.has('simulate')),
    lensStatus: () => queue.status,
    lensTimings: () => queue.timings,
    syncMotion: link?.syncMotion ?? (() => {}),
    restartImu: link?.startImu ?? (async () => false),
    wearCheckStatus: () => link?.wearCheck.snapshot(now()) ?? null,
    startWearCheck: link?.startWearCheck ?? (() => {}),
    cancelWearCheck: link?.cancelWearCheck ?? (() => {}),
  };
  refreshPanel = initPanel(host);
  if (import.meta.env.DEV && !scriptedSimulation && !params.has('simulate')) {
    const { startDevLog } = await import('./devLog.ts');
    startDevLog(assistant, () => ({ revision: APP_REVISION, pageReady, lens: queue.status,
      lensTimings: queue.timings, wearCheck: link?.wearCheck.snapshot(now()) ?? null }));
  }
  lastState = assistant.state;
  console.log(`STATE ${lastState}`);

  if (import.meta.env.DEV && new URLSearchParams(location.search).has('autopilot')) {
    const { runAutopilot } = await import('./autopilot.ts');
    void runAutopilot(host);
  }
  if (import.meta.env.DEV && params.get('e2e')) {
    const { runE2eDriver } = await import('./e2eDriver.ts');
    void runE2eDriver(host, params.get('e2e') ?? '');
  }
}

void main();
