import {
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import type { BridgeLane } from './core/bridgeLane.ts';
import { SCREEN } from './core/paging.ts';
import { BLANK_TEXT, type DisplayPort } from './core/renderQueue.ts';

const MAIN = { id: 1, name: 'main' };

// One full-screen text container with no border. One container means one update
// blanks the whole lens at once, and no border means Hidden lights no pixels.
function layout(content: string) {
  return {
    containerTotalNum: 1,
    textObject: [
      new TextContainerProperty({
        xPosition: 0, yPosition: 0, width: SCREEN.width, height: SCREEN.height,
        borderWidth: 0, borderColor: 0, paddingLength: SCREEN.padding,
        containerID: MAIN.id, containerName: MAIN.name,
        content, isEventCapture: 1,
      }),
    ],
  };
}

export class GlassesPort implements DisplayPort {
  private readonly bridge: EvenAppBridge;
  private readonly lane: BridgeLane;

  constructor(bridge: EvenAppBridge, lane: BridgeLane) {
    this.bridge = bridge;
    this.lane = lane;
  }

  /** The first page is always blank, so a start can never flash content. */
  async init(): Promise<boolean> {
    const result = await this.lane.run(() => this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(layout(BLANK_TEXT))), true).catch(() => -1);
    if (result === 0) return true;
    // After a WebView reload the host keeps the old page and rejects a second
    // startup call (seen in the simulator during Study Lens work), so redraw.
    console.warn(`createStartUpPageContainer returned ${result}, rebuilding the page`);
    return this.rebuild(BLANK_TEXT).catch(() => false);
  }

  setText(content: string): Promise<boolean> {
    return this.lane.run(() => this.bridge.textContainerUpgrade(new TextContainerUpgrade({
      containerID: MAIN.id, containerName: MAIN.name, contentOffset: 0, contentLength: 0, content,
    })), true);
  }

  rebuild(content: string): Promise<boolean> {
    return this.lane.run(() => this.bridge.rebuildPageContainer(new RebuildPageContainer(layout(content))), true);
  }
}
