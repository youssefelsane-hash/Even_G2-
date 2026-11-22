import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rig } from './helpers.ts';

test('the lens header says offline while the server is unreachable, and only while text shows', async () => {
  const r = await new Rig().ready();
  r.a.setServerOffline(true);
  assert.equal(r.lit(), false, 'marking offline never reveals a hidden lens');
  for (let i = 0; i < 4; i++) r.a.handleTouch('press');
  assert.equal(r.a.state, 'VISIBLE');
  assert.match(r.text(), /! offline/);
  r.a.setServerOffline(false);
  assert.doesNotMatch(r.text(), /offline/);
});
