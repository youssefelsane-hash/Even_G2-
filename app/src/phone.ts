// Development page (phone.html): stands in for the body-worn camera until one is
// bought. It sends photos from the phone camera exactly as the camera does
// (POST /v1/captures, multipart meta + frame0..2, one Idempotency-Key per press,
// device token) through the dev server's /v1 proxy, then shows the job status.
// Like the camera, it never receives the answer text: that goes to the glasses.

const MAX_SIDE = 2048;
const MAX_BYTES = 2_500_000;
const MAX_FRAMES = 3;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
const preview = $('preview');

function say(text: string, kind: '' | 'ok' | 'bad' = ''): void {
  statusEl.textContent = text;
  statusEl.className = kind;
}

interface Frame { name: string; score: number; width: number; height: number; brightness: number; blob: Blob }

async function toJpeg(file: File, index: number): Promise<Frame> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  // Mean brightness from a coarse grid, so the server can say "too dark".
  const data = ctx.getImageData(0, 0, width, height).data;
  let sum = 0, n = 0;
  const step = Math.max(1, Math.floor((width * height) / 20_000)) * 4;
  for (let i = 0; i < data.length; i += step) { sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; n++; }
  for (const quality of [0.88, 0.78, 0.65, 0.5]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', quality));
    if (blob && blob.size <= MAX_BYTES) {
      return { name: `phone${index}`, score: 1, width, height, brightness: Math.round(sum / Math.max(n, 1)), blob };
    }
  }
  throw new Error('photo too large even after compression');
}

let tokens: { deviceToken: string; deviceId: string } | null = null;

async function loadTokens(): Promise<boolean> {
  try {
    const res = await fetch('./__dev/backend', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const t = await res.json() as { deviceToken?: string; deviceId?: string };
    if (!t.deviceToken || !t.deviceId) throw new Error('no device token');
    tokens = { deviceToken: t.deviceToken, deviceId: t.deviceId };
    return true;
  } catch {
    say('The local backend is not set up on the computer.', 'bad');
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

async function send(files: File[]): Promise<void> {
  if (!files.length) return;
  if (!tokens && !(await loadTokens())) return;
  const picked = files.slice(0, MAX_FRAMES);
  say(`Preparing ${picked.length} photo${picked.length > 1 ? 's' : ''}…`);
  preview.replaceChildren(...picked.map((f) => Object.assign(document.createElement('img'), { src: URL.createObjectURL(f), alt: '' })));
  let frames: Frame[];
  try {
    frames = await Promise.all(picked.map(toJpeg));
  } catch (e) {
    say(`Could not read the photo: ${(e as Error).message}`, 'bad');
    return;
  }
  const meta: Record<string, unknown> = {
    mode: frames.length === 1 ? 'single' : 'burst',
    capturedAt: new Date().toISOString(),
    frames: frames.map(({ blob: _b, ...f }) => f),
  };
  if ($<HTMLInputElement>('append').checked) meta.appendTo = 'previous';
  const key = newKey(); // one per press, reused on every retry
  const headers = { Authorization: `Bearer ${tokens!.deviceToken}`, 'X-Device-Id': tokens!.deviceId, 'Idempotency-Key': key };

  let jobId = '';
  for (let attempt = 1; attempt <= 5 && !jobId; attempt++) {
    say(attempt === 1 ? 'Sending…' : `Sending again (try ${attempt})…`);
    const form = new FormData();
    form.append('meta', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
    frames.forEach((f, i) => form.append(`frame${i}`, f.blob, `frame${i}.jpg`));
    try {
      const res = await fetch('./v1/captures', { method: 'POST', body: form, headers });
      const body = await res.json().catch(() => ({})) as { jobId?: string; glassesListening?: boolean; error?: string };
      if (res.ok && body.jobId) {
        jobId = body.jobId;
        if (body.glassesListening === false) say('Sent. The glasses app is not connected right now; the answer will wait for it.');
        break;
      }
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        say(`The server refused the photo (${res.status}${body.error ? `: ${body.error}` : ''}).`, 'bad');
        return;
      }
    } catch { /* network: retry */ }
    await sleep(1000 * 2 ** (attempt - 1));
  }
  if (!jobId) { say('Could not reach the server. Is the computer awake and on the same Wi-Fi?', 'bad'); return; }

  const until = Date.now() + 120_000;
  let last = '';
  while (Date.now() < until) {
    await sleep(1500);
    try {
      const res = await fetch(`./v1/captures/${encodeURIComponent(jobId)}`, { headers, cache: 'no-store' });
      if (!res.ok) continue;
      const s = await res.json() as { status: string; retakeReason?: string };
      if (s.status === last) continue;
      last = s.status;
      if (s.status === 'queued') say('Received. Waiting for the AI…');
      else if (s.status === 'processing') say('The AI is reading it…');
      else if (s.status === 'ready') { say('Done. The answer is on the glasses (tap 4 times on the right if they are locked).', 'ok'); return; }
      else if (s.status === 'retake') { say(`Take it again: ${s.retakeReason ?? 'not readable'}.`, 'bad'); return; }
      else if (s.status === 'failed') { say('The AI failed on this one. Try again.', 'bad'); return; }
    } catch { /* keep polling */ }
  }
  say('Still working. The answer will appear on the glasses when it is ready.');
}

for (const id of ['shoot', 'pick']) {
  const input = $<HTMLInputElement>(id);
  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []);
    input.value = '';
    void send(files);
  });
}
void loadTokens().then((ok) => { if (ok) say('Ready.'); });
