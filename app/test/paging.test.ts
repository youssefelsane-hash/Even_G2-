import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTextWidth } from '@evenrealities/pretext';
import { Pager, TEXT_WIDTH, TOTAL_LINES, wrapText } from '../src/core/paging.ts';

test('the layout fits the 288 px screen at the 27 px line height', () => {
  assert.equal(TOTAL_LINES, 10);
  assert.ok(TOTAL_LINES * 27 <= 288 - 8);
});

test('every wrapped line fits the width, measured with the firmware font metrics', () => {
  const text = 'The quick brown fox jumps over the lazy dog. '.repeat(30) + 'x'.repeat(300);
  const lines = wrapText(text, TEXT_WIDTH, getTextWidth);
  assert.ok(lines.length > 5);
  for (const l of lines) assert.ok(getTextWidth(l) <= TEXT_WIDTH, `${getTextWidth(l)} px: ${l}`);
});

test('wrapping keeps explicit line breaks and blank lines, and drops trailing ones', () => {
  assert.deepEqual(wrapText('a\n\nb\n\n'), ['a', '', 'b']);
});

test('wrapping loses no words', () => {
  const words = Array.from({ length: 200 }, (_, i) => `w${i}`);
  assert.deepEqual(wrapText(words.join(' ')).join(' ').split(' '), words);
});

test('scrolling is clamped at both ends', () => {
  const p = new Pager(5);
  p.setText(Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n'));
  assert.equal(p.scrollBy(-3), false);
  assert.equal(p.topLine, 0);
  p.scrollBy(100);
  assert.equal(p.topLine, 7);
  assert.equal(p.scrollBy(1), false);
  assert.deepEqual(p.visible(), ['line 7', 'line 8', 'line 9', 'line 10', 'line 11']);
});

test('short text cannot scroll', () => {
  const p = new Pager(5);
  p.setText('one line');
  assert.equal(p.scrollBy(1), false);
});

test('a stored position is restored and clamped', () => {
  const p = new Pager(5);
  const text = Array.from({ length: 12 }, (_, i) => `${i}`).join('\n');
  p.setText(text, 4);
  assert.equal(p.topLine, 4);
  p.setText(text, 999);
  assert.equal(p.topLine, 7);
});
