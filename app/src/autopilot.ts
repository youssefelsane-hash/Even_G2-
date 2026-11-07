import { scenario } from './core/scenarios.ts';
import { still } from './core/synth.ts';
import { playMotion } from './motionPlayer.ts';
import type { PanelHost } from './panel.ts';
import { sampleAnswer } from './sampleAnswer.ts';

// Development only (?autopilot). The simulator's automation API can press the
// touchpad but cannot reach the phone panel, so this drives the steps that need
// injected motion and wear changes. tools/sim-e2e.mjs reads the STEP lines from
// the console and takes a glasses screenshot during each pause.
const PAUSE_MS = 2500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runAutopilot({ assistant, now }: PanelHost): Promise<void> {
  const step = async (name: string): Promise<void> => {
    const s = assistant.snapshot();
    console.log(`STEP ${name} state=${s.state} wear=${s.wear} top=${s.topLine}`);
    await sleep(PAUSE_MS);
  };
  const motion = (name: string) => playMotion(assistant, scenario(name).motion(1), now);
  const warm = () => playMotion(assistant, still(1200), now);

  await sleep(1500);
  assistant.handleConnection(true);
  await step('start');

  assistant.handleWear(true);
  await sleep(assistant.settings.wearSettleMs + 200);
  await warm();
  await motion('shake');
  assistant.aiResult(sampleAnswer());
  await step('visible-answer');

  await motion('tilt-down');
  await step('visible-scrolled');

  await motion('shake');
  await step('hidden');

  assistant.aiStarted();
  assistant.aiResult(sampleAnswer());
  await step('hidden-with-result');

  await motion('shake');
  await step('visible-new-result');

  await motion('tilt-down');
  await step('visible-position-before-hide');
  await motion('shake');
  await step('hidden-again');
  await motion('shake');
  await step('visible-position-restored');

  assistant.handleWear(false);
  await step('removed');

  assistant.handleWear(true);
  await step('rewear-stays-hidden');

  // The driver now tests touch recovery and swipes through the real simulator input.
  console.log('STEP done');
}
