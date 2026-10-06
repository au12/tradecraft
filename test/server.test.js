// End-to-end tests: boot the real server and play over WebSockets.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 39000 + Math.floor(Math.random() * 900);
const HTTP = `http://127.0.0.1:${PORT}`;
let server;

before(async () => {
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', PERSIST: 'false', LOG_LEVEL: 'silent' },
    stdio: 'inherit',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${HTTP}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => server?.kill());

async function createRoom() {
  const res = await fetch(`${HTTP}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 201);
  return (await res.json()).code;
}

/** A tiny test client: tracks the latest state and lets tests await changes. */
function client(room, name, token = `token-${name}-${Math.random().toString(36).slice(2)}-pad`) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const c = { ws, name, token, state: null, errors: [], fatal: null, waiters: [], seq: 0, replies: new Map() };
  const check = () => {
    c.waiters = c.waiters.filter((w) => {
      if (!w.pred(c)) return true;
      w.resolve(c.state);
      return false;
    });
  };
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', room, token, name })));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.t === 'state') c.state = msg.s;
    if (msg.t === 'err') c.errors.push(msg.m);
    if (msg.t === 'err' || msg.t === 'ack') c.replies.set(msg.n, msg.t === 'err' ? msg.m : null);
    if (msg.t === 'fatal' || msg.t === 'kicked') c.fatal = msg;
    check();
  });
  c.until = (pred, what = 'condition') =>
    new Promise((resolve, reject) => {
      if (pred(c)) return resolve(c.state);
      const timer = setTimeout(() => reject(new Error(`${name}: timed out waiting for ${what}; errors: ${JSON.stringify(c.errors)}`)), 4000);
      c.waiters.push({ pred, resolve: (v) => (clearTimeout(timer), resolve(v)) });
    });
  c.ready = () => c.until((x) => x.state !== null, 'first state');
  c.act = (a, data = {}) => ws.send(JSON.stringify({ t: 'a', a, ...data }));
  c.me = () => c.state.players.find((p) => p.id === c.state.you);
  /** Sends an action and waits for the server's answer: null on success, else the error text. */
  c.do = async (a, data = {}) => {
    const n = ++c.seq;
    ws.send(JSON.stringify({ t: 'a', a, n, ...data }));
    await c.until((x) => x.replies.has(n) || x.fatal, `result of ${a}`);
    return c.replies.get(n) ?? null;
  };
  return c;
}

async function classicTable() {
  const code = await createRoom();
  const ana = client(code, 'Ana'); // first in, so Ana hosts
  await ana.ready();
  const [bo, cy, dee] = ['Bo', 'Cy', 'Dee'].map((n) => client(code, n));
  await Promise.all([bo.ready(), cy.ready(), dee.ready()]);
  await ana.do('join', { team: 'red', role: 'spymaster' });
  await bo.do('join', { team: 'red', role: 'operative' });
  await cy.do('join', { team: 'blue', role: 'spymaster' });
  await dee.do('join', { team: 'blue', role: 'operative' });
  await ana.until((x) => x.state.players.filter((p) => p.team).length === 4, 'everyone seated');
  return { code, ana, bo, cy, dee, all: [ana, bo, cy, dee] };
}

test('serves the app, the packs and a health check', async () => {
  const html = await (await fetch(`${HTTP}/`)).text();
  assert.match(html, /<base href="\/">/);
  assert.ok(!html.includes('{{'), 'template placeholders are filled in');
  const packs = (await (await fetch(`${HTTP}/api/packs`)).json()).packs;
  assert.ok(packs.length >= 5);
  assert.equal(packs[0].id, 'everyday');
  assert.equal((await fetch(`${HTTP}/api/rooms/nope-nope-00`)).status, 404);
  assert.equal((await fetch(`${HTTP}/../package.json`)).status, 404);
  assert.equal((await fetch(`${HTTP}/%2e%2e/package.json`)).status, 404);
});

test('a room that does not exist is refused', async () => {
  const c = client('no-such-room', 'Zed');
  await c.until((x) => x.fatal, 'fatal');
  assert.equal(c.fatal.code, 'no-room');
});

test('classic game: only spymasters ever receive the key', async () => {
  const t = await classicTable();
  const { ana, bo, cy, dee } = t;
  assert.equal(ana.state.hostId, ana.state.you, 'first player in is the host');

  assert.match(await bo.do('start'), /Only the host/);
  assert.match(await bo.do('settings', { patch: { cols: 6 } }), /Only the host/);
  assert.equal(await ana.do('start'), null);
  await Promise.all(t.all.map((c) => c.until((x) => x.state.round, 'round')));

  for (const op of [bo, dee]) {
    assert.ok(op.state.round.cards.every((c) => c.k === undefined && c.r === null), 'operatives get no key');
    assert.ok(!JSON.stringify(op.state).includes('"owner"'));
  }
  for (const spy of [ana, cy]) assert.ok(spy.state.round.cards.every((c) => typeof c.k === 'string'));

  const first = ana.state.round.turn;
  const [spy, op, otherOp] = first === 'red' ? [ana, bo, dee] : [cy, dee, bo];
  const key = spy.state.round.cards.map((c) => c.k);

  assert.match(await op.do('clue', { word: 'sneaky', count: 2 }), /Only the spymaster/);
  assert.match(await spy.do('clue', { word: spy.state.round.cards[0].w, count: 2 }), /on the board/);
  assert.equal(await spy.do('clue', { word: 'weather', count: 2 }), null);
  await op.until((x) => x.state.round.phase === 'guess', 'guess phase');
  assert.equal(op.state.round.clue.word, 'WEATHER');
  assert.equal(op.state.round.guessesLeft, 3);

  assert.match(await otherOp.do('guess', { i: 0 }), /not your turn/);
  assert.match(await spy.do('guess', { i: 0 }), /Spymasters/);

  // Pointing is visible to everyone.
  const own = key.findIndex((k) => k === first);
  await op.do('mark', { i: own });
  await otherOp.until((x) => x.state.round.cards[own].m?.length === 1, 'mark visible');

  await op.do('guess', { i: own });
  await otherOp.until((x) => x.state.round.cards[own].r === first, 'reveal visible');
  assert.equal(otherOp.state.round.cards[own].m, undefined, 'marks clear after a guess');
  assert.equal(op.state.round.remaining[first], key.filter((k) => k === first).length - 1);

  // An operative who becomes spymaster mid-round cannot go back to guessing.
  const team = first;
  await spy.do('spectate');
  assert.equal(await op.do('join', { team, role: 'spymaster' }), null);
  assert.ok(op.state.round.cards.some((c) => c.k), 'new spymaster now sees the key');
  assert.match(await op.do('join', { team, role: 'operative' }), /seen the key/);

  for (const c of t.all) c.ws.close();
});

test('classic game: wrong card passes the turn, assassin ends it, wins are counted', async () => {
  const t = await classicTable();
  const { ana, bo, cy, dee } = t;
  assert.equal(await ana.do('start'), null);
  await Promise.all(t.all.map((c) => c.until((x) => x.state.round, 'round')));
  const first = ana.state.round.turn;
  const second = first === 'red' ? 'blue' : 'red';
  const spies = { red: ana, blue: cy };
  const ops = { red: bo, blue: dee };
  const key = ana.state.round.cards.map((c) => c.k);

  await spies[first].do('clue', { word: 'alpha', count: 1 });
  await ops[first].until((x) => x.state.round.phase === 'guess');
  await ops[first].do('guess', { i: key.indexOf('neutral') });
  await ops[second].until((x) => x.state.round.turn === second && x.state.round.phase === 'clue', 'turn passed');

  await spies[second].do('clue', { word: 'beta', count: 'inf' });
  await ops[second].until((x) => x.state.round.phase === 'guess');
  assert.equal(ops[second].state.round.guessesLeft, null);
  await ops[second].do('guess', { i: key.indexOf('assassin') });
  await ana.until((x) => x.state.round.phase === 'over', 'game over');
  assert.equal(ana.state.round.winner, first);
  assert.equal(ana.state.round.reason, 'assassin');
  assert.equal(ana.state.teams.find((x) => x.id === first).wins, 1);
  await bo.until((x) => x.state.round.phase === 'over');
  assert.ok(bo.state.round.cards.every((c) => typeof c.k === 'string'), 'everyone sees the key once the round is over');

  // Next round: fresh board, the other team starts, words are not reused.
  const oldWords = new Set(ana.state.round.cards.map((c) => c.w));
  const oldId = ana.state.round.id;
  await ana.do('start', { shuffle: true });
  await ana.until((x) => x.state.round.id !== oldId, 'new round');
  assert.equal(ana.state.roundNo, 2);
  assert.equal(ana.state.round.turn, second, 'starting team rotates');
  assert.ok(ana.state.round.cards.every((c) => !oldWords.has(c.w)));
  const seated = ana.state.players.filter((p) => p.team);
  assert.equal(seated.length, 4);
  assert.equal(seated.filter((p) => p.role === 'spymaster').length, 2);
  for (const c of t.all) c.ws.close();
});

test('host tools: settings, timers, kick, reconnect', async () => {
  const t = await classicTable();
  const { ana, bo, cy, dee } = t;
  assert.equal(await ana.do('settings', { patch: { cols: 10, packs: ['python-builtins'] } }), null);
  assert.equal(ana.state.settings.cols, 10);
  assert.match(await ana.do('start'), /needs 100 words/);
  await ana.do('settings', { patch: { cols: 5, packs: ['everyday'], customWords: 'Zebra crossing, zebra crossing\nQuokka', clueSeconds: 30 } });
  assert.deepEqual(ana.state.settings.customWords, ['Zebra crossing', 'Quokka']);
  assert.equal(bo.state.settings.customWords, undefined, 'custom words are only sent to the host');

  await ana.do('start');
  await ana.until((x) => x.state.round?.deadline, 'timer running');
  assert.match(await ana.do('settings', { patch: { teamCount: 3 } }), /End the current round/);
  const first = ana.state.round.turn;

  await ana.do('pause', { on: true });
  assert.equal(ana.state.round.deadline, null);
  assert.ok(ana.state.round.pausedLeft > 25_000);
  await ana.do('pause', { on: false });
  // Shorten the clock and let it run out: the turn passes.
  await ana.do('addTime', { secs: -600 });
  await ana.until((x) => x.state.round.turn !== first, 'timeout passes the turn');
  assert.equal(ana.state.round.log.at(-1).type, 'timeout');

  // Reconnecting with the same token keeps the seat.
  dee.ws.close();
  await ana.until((x) => x.state.players.find((p) => p.name === 'Dee')?.online === false, 'Dee offline');
  const dee2 = client(t.code, 'Dee', dee.token);
  await dee2.ready();
  assert.equal(dee2.me().team, 'blue');
  assert.equal(dee2.me().role, 'operative');

  // Kicked players cannot come back with the same token.
  const boId = bo.me().id;
  await ana.do('kick', { id: boId });
  await bo.until((x) => x.fatal, 'kick notice');
  const bo2 = client(t.code, 'Bo', bo.token);
  await bo2.until((x) => x.fatal, 'ban');
  assert.equal(bo2.fatal.code, 'banned');

  // A locked room refuses newcomers.
  await ana.do('lock', { on: true });
  const late = client(t.code, 'Late');
  await late.until((x) => x.fatal, 'locked');
  assert.equal(late.fatal.code, 'locked');

  for (const c of [ana, cy, dee2]) c.ws.close();
});

test('co-op: each side sees only its own key and they can win together', async () => {
  const code = await createRoom();
  const ana = client(code, 'Ana');
  await ana.ready();
  const bo = client(code, 'Bo');
  const eve = client(code, 'Eve');
  await Promise.all([bo.ready(), eve.ready()]);
  await ana.do('settings', { patch: { mode: 'coop' } });
  await ana.do('join', { team: 'red' });
  await bo.do('join', { team: 'blue' });
  await ana.until((x) => x.state.players.filter((p) => p.team).length === 2);
  await ana.do('start');
  await Promise.all([ana, bo, eve].map((c) => c.until((x) => x.state.round, 'round')));

  const count = (c, kind) => c.state.round.cards.filter((x) => x.k === kind).length;
  for (const c of [ana, bo]) {
    assert.equal(count(c, 'agent'), 9);
    assert.equal(count(c, 'assassin'), 3);
    assert.ok(c.state.round.cards.every((x) => x.ks === undefined));
  }
  assert.ok(eve.state.round.cards.every((x) => x.k === undefined), 'spectators see no key');
  assert.match(await bo.do('join', { team: 'red' }), /other side/);

  const side = { red: ana, blue: bo };
  const keys = { red: ana.state.round.cards.map((c) => c.k), blue: bo.state.round.cards.map((c) => c.k) };
  let n = 0;
  while (ana.state.round.phase !== 'over' && n++ < 30) {
    const cluer = ana.state.round.turn;
    const guesser = cluer === 'red' ? 'blue' : 'red';
    assert.equal(await side[cluer].do('clue', { word: `hint${n}`, count: 'inf' }), null);
    await side[guesser].until((x) => x.state.round.phase === 'guess');
    for (;;) {
      const r = side[guesser].state.round;
      if (r.phase !== 'guess') break;
      const i = r.cards.findIndex((c, idx) => !c.r && keys[cluer][idx] === 'agent');
      if (i === -1) {
        await side[guesser].do('endGuess');
        break;
      }
      await side[guesser].do('guess', { i });
    }
    await ana.until((x) => x.state.round.phase !== 'guess', 'turn to finish');
  }
  assert.equal(ana.state.round.outcome, 'win');
  assert.equal(ana.state.coop.wins, 1);
  await eve.until((x) => x.state.round.phase === 'over');
  assert.ok(eve.state.round.cards.filter((c) => !c.r).every((c) => c.ks), 'both keys are shown at the end');
  for (const c of [ana, bo, eve]) c.ws.close();
});
