// The app states from the spec. The camera job runs independently of what is on
// the lens, so internally there are two fields; `flatState` gives the single
// spec state, and Hidden and Removed always take priority over the job.
export type AppState = 'VISIBLE' | 'HIDDEN' | 'REMOVED' | 'PROCESSING' | 'RESULT_READY' | 'ERROR';
export type Mode = 'VISIBLE' | 'HIDDEN' | 'REMOVED';
export type Job = 'IDLE' | 'PROCESSING' | 'RESULT_READY' | 'ERROR';
export type Wear = 'worn' | 'removed' | 'unknown';

export interface MachineState {
  mode: Mode;
  job: Job;
  wear: Wear;
  /** A result or error arrived while nothing could be shown. */
  unseen: boolean;
}

export type MachineEvent =
  | { type: 'SHAKE' }
  | { type: 'SCROLL'; source: 'tilt' | 'touch' }
  | { type: 'TOUCH_RECOVERY' }
  | { type: 'UNDO_HIDE' }
  | { type: 'ACK' }
  | { type: 'WEAR'; wear: Wear }
  | { type: 'CONNECTION'; connected: boolean }
  | { type: 'EXIT' }
  | { type: 'AI_STARTED' }
  | { type: 'AI_RESULT' }
  | { type: 'AI_ERROR' };

export interface Transition {
  state: MachineState;
  /** False when the event was ignored. */
  accepted: boolean;
}

// Every start is Hidden, whatever was happening before. The mode is never
// stored, so no saved value can reveal content after a restart.
export function bootState(unseenResult = false): MachineState {
  return { mode: 'HIDDEN', job: unseenResult ? 'RESULT_READY' : 'IDLE', wear: 'unknown', unseen: unseenResult };
}

export function flatState(s: MachineState): AppState {
  if (s.mode !== 'VISIBLE' || s.job === 'IDLE') return s.mode;
  return s.job;
}

export function contentAllowed(s: MachineState): boolean {
  return s.mode === 'VISIBLE';
}

function reveal(s: MachineState): MachineState {
  return { ...s, mode: 'VISIBLE', unseen: false };
}

export function reduce(s: MachineState, e: MachineEvent): Transition {
  const yes = (state: MachineState): Transition => ({ state, accepted: true });
  const no: Transition = { state: s, accepted: false };

  switch (e.type) {
    case 'SHAKE':
      if (s.wear !== 'worn') return no; // gestures are ignored unless the glasses are known to be worn
      if (s.mode === 'VISIBLE') return yes({ ...s, mode: 'HIDDEN' });
      if (s.mode === 'HIDDEN') return yes(reveal(s));
      return no;

    case 'SCROLL':
      if (s.mode !== 'VISIBLE') return no;
      if (e.source === 'tilt' && s.wear !== 'worn') return no;
      return yes(s);

    case 'TOUCH_RECOVERY':
      // Works when the wear state is unknown, so a failed sensor cannot trap
      // the app. Never works when the glasses are reported as removed.
      if (s.mode !== 'HIDDEN' || s.wear === 'removed') return no;
      return yes(reveal(s));

    case 'UNDO_HIDE':
      // Stricter than touch recovery: only while the glasses are known to be worn.
      if (s.mode !== 'HIDDEN' || s.wear !== 'worn') return no;
      return yes(reveal(s));

    case 'ACK':
      if (s.mode !== 'VISIBLE') return no;
      if (s.job === 'RESULT_READY' || s.job === 'ERROR') return yes({ ...s, job: 'IDLE' });
      return no;

    case 'WEAR':
      if (e.wear === s.wear) return no;
      if (e.wear === 'removed') return yes({ ...s, wear: 'removed', mode: 'REMOVED' });
      if (e.wear === 'worn') return yes({ ...s, wear: 'worn', mode: s.mode === 'REMOVED' ? 'HIDDEN' : s.mode });
      // Unknown: not proof of removal, but not safe to keep showing content.
      return yes({ ...s, wear: 'unknown', mode: s.mode === 'VISIBLE' ? 'HIDDEN' : s.mode });

    case 'CONNECTION':
      if (e.connected) return no; // reconnecting never reveals; wear status decides what comes next
      return yes({ ...s, wear: 'unknown', mode: s.mode === 'VISIBLE' ? 'HIDDEN' : s.mode });

    case 'EXIT':
      // The host closed the app. If it comes back, that is like a restart: never revealed.
      return yes({ ...s, mode: s.mode === 'VISIBLE' ? 'HIDDEN' : s.mode });

    case 'AI_STARTED':
      return yes({ ...s, job: 'PROCESSING' });

    case 'AI_RESULT':
      return yes({ ...s, job: 'RESULT_READY', unseen: s.mode !== 'VISIBLE' });

    case 'AI_ERROR':
      return yes({ ...s, job: 'ERROR', unseen: s.mode !== 'VISIBLE' });
  }
}
