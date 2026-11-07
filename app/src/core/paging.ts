// App-managed text layout for the 576x288 display. The firmware gives no way to
// read or set its own text scroll position, so the app sends exactly one screen
// of lines at a time and owns the position itself.

export const SCREEN = { width: 576, height: 288, lineHeight: 27, padding: 4 } as const;
export const TOTAL_LINES = Math.floor((SCREEN.height - 2 * SCREEN.padding) / SCREEN.lineHeight); // 10
export const TEXT_WIDTH = SCREEN.width - 2 * SCREEN.padding;
export const MAX_SCREEN_CHARS = 1000; // rebuildPageContainer limit, the smallest of the text limits

export type Measure = (text: string) => number;

// Rough stand-in for tests and browsers. The app uses the firmware font metrics.
export const approxMeasure: Measure = (s) => s.length * 10;

function breakWord(word: string, maxPx: number, measure: Measure): string[] {
  const parts: string[] = [];
  let cur = '';
  for (const ch of word) {
    if (cur && measure(cur + ch) > maxPx) {
      parts.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

export function wrapText(text: string, maxPx: number = TEXT_WIDTH, measure: Measure = approxMeasure): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    let cur = '';
    for (const word of paragraph.split(/[ \t]+/).filter(Boolean)) {
      const joined = cur ? `${cur} ${word}` : word;
      if (measure(joined) <= maxPx) {
        cur = joined;
        continue;
      }
      if (cur) lines.push(cur);
      cur = '';
      const pieces = measure(word) <= maxPx ? [word] : breakWord(word, maxPx, measure);
      cur = pieces.pop() ?? '';
      lines.push(...pieces);
    }
    lines.push(cur);
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export class Pager {
  private all: string[] = [];
  private top = 0;
  readonly viewLines: number;
  private readonly measure: Measure;

  constructor(viewLines: number = TOTAL_LINES - 1, measure: Measure = approxMeasure) {
    this.viewLines = viewLines;
    this.measure = measure;
  }

  setText(text: string, topLine = 0): void {
    this.all = wrapText(text, TEXT_WIDTH, this.measure);
    this.top = 0;
    this.moveTo(topLine);
  }

  /** Lays out other text with the same font metrics. */
  wrap(text: string): string[] {
    return wrapText(text, TEXT_WIDTH, this.measure);
  }

  get topLine(): number { return this.top; }
  get lineCount(): number { return this.all.length; }
  get maxTop(): number { return Math.max(0, this.all.length - this.viewLines); }

  moveTo(line: number): void {
    this.top = Math.min(this.maxTop, Math.max(0, Math.round(line)));
  }

  /** Returns true if the position changed. */
  scrollBy(lines: number): boolean {
    const before = this.top;
    this.moveTo(this.top + lines);
    return this.top !== before;
  }

  visible(): string[] {
    return this.all.slice(this.top, this.top + this.viewLines);
  }
}
