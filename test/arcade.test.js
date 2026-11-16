// The au12 Arcade: what the server allows with ARCADE_URL set and without,
// and what the page reports to the arcade.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const servers = [];
after(() => servers.forEach((s) => s.kill()));

async function boot(env) {
  const port = 42000 + Math.floor(Math.random() * 900) + servers.length * 1000;
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PERSIST: 'false', LOG_LEVEL: 'silent', ...env },
    stdio: 'inherit',
  });
  servers.push(server);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return base;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

test('without ARCADE_URL nothing changes', async () => {
  const base = await boot({});
  const page = await fetch(`${base}/`);
  assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.doesNotMatch(page.headers.get('content-security-policy'), /frame-ancestors/);
  assert.equal((await fetch(`${base}/arcade.json`)).status, 404);
});

test('with ARCADE_URL the arcade may frame the game and hear from it', async () => {
  const base = await boot({ ARCADE_URL: 'https://arcade.example.com/' });
  const page = await fetch(`${base}/r/quiet-falcon-12`);
  const csp = page.headers.get('content-security-policy');
  assert.equal(page.headers.get('x-frame-options'), null);
  assert.match(csp, /frame-ancestors 'self' https:\/\/arcade\.example\.com(;|$)/);
  assert.match(csp, /connect-src 'self' ws: wss: https:\/\/arcade\.example\.com;/);
  assert.match(await page.text(), /<script src="js\/vendor\/arcade\.js" data-game="tradecraft" data-config="\/arcade\.json"><\/script>/);
  const cfg = await fetch(`${base}/arcade.json`);
  assert.deepEqual(await cfg.json(), { url: 'https://arcade.example.com' });
});

test('the page reports rounds it saw end, once each', async () => {
  const sent = [];
  const memory = new Map();
  globalThis.localStorage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)) };
  globalThis.Arcade = {
    mode: 'embedded',
    kiosk: false,
    player: { id: 'p-dad', name: 'Dad' },
    ready: Promise.resolve(null),
    result: (outcome, opts) => sent.push({ outcome, ...opts.meta }),
    status: () => {},
    invite: () => {},
  };
  const { arcadeReport } = await import('../public/js/arcade.js');

  const players = (myTeams, role = 'operative') => [
    { id: 'me', teams: myTeams, role },
    { id: 'x', teams: ['red'], role: 'spymaster' },
    { id: 'y', teams: ['blue'], role: 'spymaster' },
    { id: 'z', teams: [], role: 'spectator' },
  ];
  const state = (round, myTeams, role) => ({ you: 'me', players: players(myTeams, role), round });
  const live = (id) => ({ id, phase: 'guess', order: ['red', 'blue'], winner: null, reason: null });
  const over = (id, winner, reason) => ({ ...live(id), phase: 'over', winner, reason });

  arcadeReport(state(live('r1'), ['red']), state(over('r1', 'red', 'agents'), ['red']));
  arcadeReport(state(live('r1'), ['red']), state(over('r1', 'red', 'agents'), ['red']));
  assert.deepEqual(sent, [{ outcome: 'win', role: 'operative', reason: 'agents', teams: 2, players: 3 }]);

  // Your side touched the assassin.
  arcadeReport(state(live('r2'), ['blue'], 'spymaster'), state(over('r2', 'red', 'assassin'), ['blue'], 'spymaster'));
  assert.deepEqual(sent[1], { outcome: 'loss', role: 'spymaster', reason: 'assassin', teams: 2, players: 3 });

  // Nothing for: a round already over when the page opened, a round called
  // off, a spectator, and a spymaster running every team.
  arcadeReport(null, state(over('r3', 'red', 'agents'), ['red']));
  arcadeReport(state(live('r4'), ['red']), state({ ...over('r4', null, 'abandoned') }, ['red']));
  arcadeReport(state(live('r5'), []), state(over('r5', 'red', 'agents'), []));
  arcadeReport(state(live('r6'), ['red', 'blue'], 'spymaster'), state(over('r6', 'red', 'agents'), ['red', 'blue'], 'spymaster'));
  assert.equal(sent.length, 2);
});
