// Entry point: routing, the connection, dialogs, and wiring clicks to actions.

import { $, $$, esc, formatClock, icon, store, toast } from './util.js';
import { Connection } from './net.js';
import { play, setSound, soundOn } from './sound.js';
import { renderBoard } from './board.js';
import { myMove, renderRails, renderStatus } from './view.js';

const cfg = JSON.parse($('#config').textContent);
const KINDS_FOR_HOME = [...Array(9).fill('red'), ...Array(8).fill('blue'), ...Array(7).fill('neutral'), 'assassin'];

let conn = null;
let state = null;
let me = null;
let clockOffset = 0;
let packs = [];
let settingsSig = '';
let lastTick = null;

const send = (action, data) => conn?.send(action, data);
const api = (path) => new URL(path, document.baseURI).toString();

// ───────────────────────── boot ─────────────────────────

function hydrateIcons() {
  for (const el of $$('[data-icon]')) {
    const name = el.dataset.icon;
    if (name === 'sound') el.innerHTML = icon(soundOn() ? 'soundOn' : 'soundOff');
    else if (name === 'theme') el.innerHTML = icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon');
    else el.innerHTML = icon(name);
  }
}

function currentRoomCode() {
  const base = new URL(document.baseURI).pathname;
  const rel = location.pathname.startsWith(base) ? location.pathname.slice(base.length) : location.pathname.replace(/^\//, '');
  const m = /^r\/([^/]+)\/?$/.exec(rel);
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}

function goToRoom(code) {
  location.href = api(`r/${encodeURIComponent(code)}`);
}

function show(id) {
  for (const view of ['home', 'room', 'notice']) $(`#${view}`).hidden = view !== id;
}

function notice(title, text, actions) {
  $('#notice-title').textContent = title;
  $('#notice-text').textContent = text;
  $('#notice-actions').innerHTML = actions;
  show('notice');
}

function boot() {
  hydrateIcons();
  bindGlobal();
  const code = currentRoomCode();
  if (code) enterRoom(code);
  else showHome();
}

// ───────────────────────── home ─────────────────────────

function dealHomeKey() {
  const kinds = KINDS_FOR_HOME.map((k) => [Math.random(), k]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  $('#home-key').innerHTML = kinds.map((k, i) => `<i data-kind="${k}" style="--n:${i}"></i>`).join('');
}

async function createRoom() {
  const body = cfg.needsPassword ? { password: $('#create-password').value } : {};
  const res = await fetch(api('api/rooms'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not create a room.');
  return data.code;
}

function showHome() {
  show('home');
  document.title = cfg.siteName;
  $('#create-password-row').hidden = !cfg.needsPassword;
  dealHomeKey();

  $('#create-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.target.querySelector('button');
    button.disabled = true;
    try {
      goToRoom(await createRoom());
    } catch (err) {
      toast(err.message, { error: true });
      button.disabled = false;
    }
  });

  $('#join-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    let code = $('#join-code').value.trim();
    // Accept a pasted invite link as well as a bare code.
    const fromLink = /\/r\/([^/?#\s]+)/.exec(code);
    if (fromLink) code = fromLink[1];
    code = code.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (!code) return toast('Type the room code first.', { error: true });
    const res = await fetch(api(`api/rooms/${encodeURIComponent(code)}`)).catch(() => null);
    if (res?.ok) goToRoom(code);
    else toast('There is no room with that code. Check the spelling, or create a new room.', { error: true });
  });
}

// ───────────────────────── room ─────────────────────────

function token() {
  let t = store.get('token');
  if (!t || t.length < 16) {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    t = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    store.set('token', t);
  }
  return t;
}

function askName({ rename = false } = {}) {
  const dialog = $('#dlg-name');
  dialog.dataset.rename = rename ? '1' : '';
  $('#name-submit').textContent = rename ? 'Save name' : 'Join room';
  $('#name-input').value = store.get('name', '');
  if (!dialog.open) dialog.showModal();
  $('#name-input').select();
}

function enterRoom(code) {
  show('room');
  $('#invite-code').textContent = code;
  document.title = `${code} | ${cfg.siteName}`;
  buildClueCounts();
  fetch(api('api/packs'))
    .then((r) => r.json())
    .then((d) => {
      packs = d.packs ?? [];
      settingsSig = '';
      if ($('#dlg-settings').open) renderSettings();
    })
    .catch(() => {});

  const name = store.get('name');
  if (name) return connect(code, name);
  // No name yet: make sure the room exists before asking for one.
  fetch(api(`api/rooms/${encodeURIComponent(code)}`))
    .then((res) => (res.status === 404 ? roomMissing() : askName()))
    .catch(() => askName());
}

const homeLink = () => `<a class="btn" href="${esc(api('.'))}">Go to the home page</a>`;

function roomMissing() {
  notice(
    'That room isn’t here',
    'It may have expired, or the link has a typo.',
    `<button class="btn btn-primary" data-act="create-from-notice">Create a new room</button>${homeLink()}`,
  );
}

function connect(code, name) {
  conn?.close();
  conn = new Connection({
    room: code,
    token: token(),
    name,
    onState: render,
    onError: (message) => toast(message, { error: true }),
    onStatus: (up) => ($('#conn-banner').hidden = up),
    onFatal: (kind, message) => {
      const home = homeLink();
      if (kind === 'name') return askName();
      if (kind === 'no-room') return roomMissing();
      if (kind === 'locked') return notice('This room is locked', 'Ask the host to unlock it, then reload this page.', `<button class="btn btn-primary" data-act="reload">Try again</button>${home}`);
      if (kind === 'full') return notice('This room is full', message, home);
      return notice('You’re out of this room', message, home);
    },
  });
}

// ───────────────────────── render ─────────────────────────

function render(next) {
  const prev = state;
  state = next;
  clockOffset = next.now - Date.now();
  me = next.players.find((p) => p.id === next.you);
  if (!me) return;

  $('#me-chip').textContent = me.name;
  $('#invite-code').textContent = next.code;
  renderRails(next, me);
  renderStatus(next, me);
  renderBoard(next, me);
  renderTimer(true);
  if ($('#dlg-settings').open) renderSettings();
  if ($('#dlg-player').open) renderPlayerDialog($('#dlg-player').dataset.id);
  effects(prev, next);
  updateTitle();
}

function updateTitle() {
  if (!state) return;
  const mine = myMove(state, me);
  document.title = `${mine && document.hidden ? '● Your move | ' : ''}${state.code} | ${cfg.siteName}`;
}

function renderTimer(full = false) {
  const r = state?.round;
  const el = $('#timer');
  const running = r && r.phase !== 'over' && (r.deadline || r.pausedLeft != null);
  el.hidden = !running;
  if (!running) return;
  const paused = r.pausedLeft != null;
  const left = paused ? r.pausedLeft : r.deadline - (Date.now() + clockOffset);
  $('#timer-value').textContent = formatClock(left);
  el.classList.toggle('is-low', !paused && left <= 10_000);
  el.classList.toggle('is-paused', paused);
  if (full) {
    const isHost = me.id === state.hostId;
    $('#timer-controls').innerHTML = isHost
      ? `<button class="tool" type="button" data-act="pause" title="${paused ? 'Resume the timer' : 'Pause the timer'}">${icon(paused ? 'play' : 'pause')}<span class="sr">${paused ? 'Resume' : 'Pause'} timer</span></button>
         <button class="tool" type="button" data-act="add-time" title="Add 30 seconds">+30<span class="sr"> seconds</span></button>`
      : '';
  }
  // A quiet tick for the last five seconds, only for whoever is on the clock.
  const secs = Math.ceil(left / 1000);
  if (!paused && secs <= 5 && secs > 0 && secs !== lastTick && myMove(state, me)) play('tick');
  lastTick = secs;
}
setInterval(() => state && renderTimer(), 250);

/** Sounds, driven by what changed between two snapshots. */
function effects(prev, next) {
  const a = prev?.round;
  const b = next.round;
  if (!prev || !b) return;
  if (!a || a.id !== b.id) return play('turn');

  let sound = null;
  b.cards.forEach((c, i) => {
    const before = a.cards[i];
    if (c.r && !before.r) {
      if (c.r === 'assassin') sound = 'assassin';
      else if (c.r === 'agent' || c.r === c.by) sound = sound ?? 'good';
      else sound = sound ?? (c.r === 'neutral' ? 'miss' : 'bad');
    } else if ((c.x?.length ?? 0) > (before.x?.length ?? 0)) {
      sound = sound ?? 'miss';
    }
  });
  if (sound) play(sound);

  if (b.phase === 'over' && a.phase !== 'over') {
    if (b.reason === 'abandoned') return;
    const won = b.mode === 'coop' ? b.outcome === 'win' : !me.team || b.winner === me.team;
    setTimeout(() => play(won ? 'win' : 'lose'), sound ? 650 : 0);
    return;
  }
  if (b.clue && b.clue.no !== a.clue?.no) return play('clue');
  if (!sound && myMove(next, me) && !myMove(prev, prev.players.find((p) => p.id === prev.you) ?? me)) play('turn');
}

// ───────────────────────── clue form ─────────────────────────

function buildClueCounts() {
  const values = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'inf'];
  $('#clue-counts').insertAdjacentHTML(
    'beforeend',
    values
      .map(
        (v) =>
          `<label><input type="radio" name="count" value="${v}"${v === '1' ? ' checked' : ''}><span>${v === 'inf' ? '∞' : v}</span></label>`,
      )
      .join(''),
  );
  $('#clue-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const word = $('#clue-word').value.trim();
    if (!word) return $('#clue-word').focus();
    const count = new FormData(event.target).get('count') ?? '1';
    send('clue', { word, count: count === 'inf' ? 'inf' : Number(count) });
  });
}

// ───────────────────────── settings dialog ─────────────────────────

const TIMER_CHOICES = [0, 30, 45, 60, 90, 120, 180, 300];
const timerLabel = (s) => (s === 0 ? 'Off' : formatClock(s * 1000));

function seg(name, options, value, disabled) {
  return `<div class="seg" role="radiogroup">${options
    .map(
      ([v, label]) =>
        `<label><input type="radio" name="${name}" value="${v}"${String(v) === String(value) ? ' checked' : ''}${disabled ? ' disabled' : ''}><span>${label}</span></label>`,
    )
    .join('')}</div>`;
}

function select(name, options, value, disabled) {
  return `<select name="${name}"${disabled ? ' disabled' : ''}>${options
    .map(([v, label]) => `<option value="${v}"${String(v) === String(value) ? ' selected' : ''}>${label}</option>`)
    .join('')}</select>`;
}

function renderSettings() {
  const s = state.settings;
  const isHost = me.id === state.hostId;
  const live = Boolean(state.round && state.round.phase !== 'over');
  const sig = JSON.stringify([s, isHost, live, state.locked, state.poolSize, state.teams.map((t) => t.name), packs.length]);
  const body = $('#settings-body');
  if (sig === settingsSig) return;
  // Don't yank the text out from under someone who is typing.
  if (body.contains(document.activeElement) && ['TEXTAREA', 'INPUT'].includes(document.activeElement.tagName) && document.activeElement.type !== 'radio' && document.activeElement.type !== 'checkbox') return;
  settingsSig = sig;

  const off = !isHost;
  const locked = off || live;
  const coop = s.mode === 'coop';
  const hostName = state.players.find((p) => p.id === state.hostId)?.name ?? 'the host';
  const sizes = [4, 5, 6, 7, 8, 9, 10].map((n) => [n, `${n} × ${n} (${n * n} cards)`]);
  const poolOk = state.poolSize >= state.cardsNeeded;
  const scroll = body.scrollTop;
  const focused = body.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = focused?.name ? `[name="${focused.name}"]${['radio', 'checkbox'].includes(focused.type) ? `[value="${focused.value}"]` : ''}` : null;

  body.innerHTML = `
    ${off ? `<p class="readonly-note">Only the host (${esc(hostName)}) can change these.</p>` : ''}
    <section class="set-group">
      <h3>Game</h3>
      <div class="set-row"><div><label>Mode</label><small>${coop ? 'Two sides, two keys, one shared goal.' : 'Teams race to find their own agents.'}</small></div>
        ${seg('mode', [['classic', 'Classic'], ['coop', 'Co-op']], s.mode, locked)}</div>
      ${
        coop
          ? `<div class="set-row"><div><label>Turns</label><small>Fewer turns is harder. Nine is standard.</small></div>
              ${select('coopTurns', [5, 6, 7, 8, 9, 10, 11, 12].map((n) => [n, `${n} turns`]), s.coopTurns, locked)}</div>`
          : `<div class="set-row"><div><label>Teams</label></div>${seg('teamCount', [[2, '2'], [3, '3'], [4, '4']], s.teamCount, locked)}</div>
             <div class="set-row"><div><label>Board</label></div>${select('cols', sizes, s.cols, locked)}</div>
             <div class="set-row"><div><label>Assassins</label><small>With three or four teams, an assassin knocks one team out.</small></div>
              ${seg('assassins', [[0, '0'], [1, '1'], [2, '2'], [3, '3']], s.assassins, locked)}</div>`
      }
      ${live && isHost ? '<p class="set-hint">End the round to change the mode, teams or board.</p>' : ''}
    </section>

    <section class="set-group">
      <h3>Words</h3>
      <div class="packs">
        ${packs
          .map(
            (p) => `<label class="pack"><input type="checkbox" name="pack" value="${esc(p.id)}"${s.packs.includes(p.id) ? ' checked' : ''}${off ? ' disabled' : ''}>
              <b>${esc(p.name)}</b><small>${p.count} words${p.description ? `. ${esc(p.description)}` : ''}</small></label>`,
          )
          .join('')}
      </div>
      ${
        isHost
          ? `<label class="field"><span>Your own words, one per line or separated by commas</span>
              <textarea name="customWords" id="custom-words" maxlength="40000" spellcheck="false" placeholder="inside jokes, coworkers, street names…">${esc((s.customWords ?? []).join('\n'))}</textarea></label>
             <div class="set-actions"><button type="button" class="btn btn-small" data-act="save-words">Save words</button></div>`
          : s.customCount
            ? `<p class="set-hint">Plus ${s.customCount} custom words from the host.</p>`
            : ''
      }
      <label class="check"><input type="checkbox" name="customOnly"${s.customOnly ? ' checked' : ''}${off ? ' disabled' : ''}>
        <span>Use only my own words<small>Ignores the packs above when you have added words.</small></span></label>
      <p class="${poolOk ? 'pool-ok' : 'pool-bad'}">${state.poolSize} words available. This board needs ${state.cardsNeeded}.</p>
    </section>

    <section class="set-group">
      <h3>Timers</h3>
      <div class="set-row"><div><label>Clue timer</label><small>How long a spymaster gets. The turn passes when it runs out.</small></div>
        ${select('clueSeconds', TIMER_CHOICES.map((t) => [t, timerLabel(t)]), s.clueSeconds, off)}</div>
      <div class="set-row"><div><label>Guess timer</label><small>How long the guessers get after each clue.</small></div>
        ${select('guessSeconds', TIMER_CHOICES.map((t) => [t, timerLabel(t)]), s.guessSeconds, off)}</div>
    </section>

    <section class="set-group">
      <h3>Clues</h3>
      <label class="check"><input type="checkbox" name="strictClues"${s.strictClues ? ' checked' : ''}${off ? ' disabled' : ''}>
        <span>Strict clue check<small>Also blocks clues that contain a face-down word, or are part of one. A clue can never be a face-down word itself.</small></span></label>
    </section>

    ${
      isHost
        ? `<section class="set-group">
            <h3>Room</h3>
            <div><label class="seat-label">Team names</label>
              <div class="team-names">${state.teams
                .map((t) => `<input type="text" name="teamName" data-team="${t.id}" value="${esc(t.name)}" maxlength="14" aria-label="Name of the ${t.id} team">`)
                .join('')}</div></div>
            <label class="check"><input type="checkbox" name="locked"${state.locked ? ' checked' : ''}>
              <span>Lock the room<small>Nobody new can join. People already here can still reconnect.</small></span></label>
            <div class="set-actions">
              <button type="button" class="btn btn-small" data-act="reset-scores">Reset scores</button>
              ${live ? '<button type="button" class="btn btn-small" data-act="end-round">End round</button>' : ''}
              ${state.round ? '<button type="button" class="btn btn-small" data-act="lobby">Back to lobby</button>' : ''}
            </div>
          </section>`
        : ''
    }`;
  body.scrollTop = scroll;
  if (focusKey) body.querySelector(focusKey)?.focus({ preventScroll: true });
}

function onSettingsChange(event) {
  const el = event.target;
  if (!state || me.id !== state.hostId) return;
  const patch = {};
  switch (el.name) {
    case 'mode':
      patch.mode = el.value;
      break;
    case 'teamCount':
    case 'cols':
    case 'assassins':
    case 'coopTurns':
    case 'clueSeconds':
    case 'guessSeconds':
      patch[el.name] = Number(el.value);
      break;
    case 'strictClues':
    case 'customOnly':
      patch[el.name] = el.checked;
      break;
    case 'pack':
      patch.packs = $$('input[name="pack"]:checked', $('#settings-body')).map((i) => i.value);
      break;
    case 'locked':
      return send('lock', { on: el.checked });
    case 'teamName':
      return send('teamName', { team: el.dataset.team, name: el.value });
    default:
      return;
  }
  settingsSig = '';
  send('settings', { patch });
}

// ───────────────────────── player dialog (host) ─────────────────────────

function renderPlayerDialog(id) {
  const dialog = $('#dlg-player');
  const p = state.players.find((x) => x.id === id);
  if (!p || me.id !== state.hostId) return dialog.open && dialog.close();
  dialog.dataset.id = id;
  $('#player-title').textContent = p.name;
  const coop = state.settings.mode === 'coop';
  const move = (team, role, label) =>
    p.team === team && (coop || p.role === role)
      ? ''
      : `<button type="button" class="btn" data-act="move" data-team="${team ?? ''}" data-role="${role}">${label}</button>`;
  const rows = state.teams
    .map((t) =>
      coop
        ? move(t.id, 'operative', `Move to ${esc(t.name)}`)
        : move(t.id, 'spymaster', `Make ${esc(t.name)} spymaster`) + move(t.id, 'operative', `Make ${esc(t.name)} operative`),
    )
    .join('');
  $('#player-body').innerHTML = `<div class="player-actions">
      ${rows}
      ${p.team ? '<button type="button" class="btn" data-act="move" data-team="" data-role="">Make spectator</button>' : ''}
      ${p.id !== state.hostId ? '<button type="button" class="btn" data-act="give-host">Make host</button>' : ''}
      ${p.id !== me.id ? '<button type="button" class="btn btn-danger" data-act="kick">Remove from room</button>' : ''}
    </div>`;
}

// ───────────────────────── events ─────────────────────────

async function copyInvite() {
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied. Send it to your friends.');
  } catch {
    window.prompt('Copy this invite link:', url);
  }
}

function bindGlobal() {
  document.addEventListener('click', (event) => {
    // Clicking the dimmed backdrop closes a dialog (except the name prompt).
    if (event.target instanceof HTMLDialogElement && event.target.id !== 'dlg-name') return event.target.close();
    const closer = event.target.closest('[data-close]');
    if (closer) return closer.closest('dialog').close();

    const confirm = event.target.closest('.confirm');
    if (confirm) return send('guess', { i: Number(confirm.dataset.i) });
    const card = event.target.closest('.card.can-pick');
    if (card) return send('mark', { i: Number(card.dataset.i) });

    const el = event.target.closest('[data-act]');
    if (!el) return;
    const playerId = $('#dlg-player').dataset.id;
    switch (el.dataset.act) {
      case 'rules':
        return $('#dlg-rules').showModal();
      case 'sound':
        setSound(!soundOn());
        hydrateIcons();
        if (soundOn()) play('clue');
        return;
      case 'theme': {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        store.set('theme', next);
        return hydrateIcons();
      }
      case 'settings':
        if (!state) return;
        settingsSig = '';
        renderSettings();
        return $('#dlg-settings').showModal();
      case 'rename':
        return askName({ rename: true });
      case 'join':
        return send('join', { team: el.dataset.team, role: el.dataset.role });
      case 'spectate':
        return send('spectate');
      case 'start':
        return send('start');
      case 'start-shuffle':
        return send('start', { shuffle: true });
      case 'shuffle':
        return send('shuffle');
      case 'end-guess':
        return send('endGuess');
      case 'end-round':
        return window.confirm('End this round now? Nobody wins it.') && send('endRound');
      case 'lobby':
        if (state?.round && state.round.phase !== 'over' && !window.confirm('Go back to the lobby? The current round will be dropped.')) return;
        return send('lobby');
      case 'lock':
        return send('lock', { on: !state.locked });
      case 'reset-scores':
        return window.confirm('Reset every team’s wins to zero?') && send('resetScores');
      case 'save-words':
        settingsSig = '';
        send('settings', { patch: { customWords: $('#custom-words').value } });
        return toast('Words saved.');
      case 'pause':
        return send('pause', { on: state.round.pausedLeft == null });
      case 'add-time':
        return send('addTime', { secs: 30 });
      case 'player':
        renderPlayerDialog(el.dataset.id);
        return $('#dlg-player').showModal();
      case 'move':
        send('move', { id: playerId, team: el.dataset.team || null, role: el.dataset.role });
        return $('#dlg-player').close();
      case 'give-host':
        send('giveHost', { id: playerId });
        return $('#dlg-player').close();
      case 'kick':
        if (!window.confirm('Remove this player? They won’t be able to rejoin from the same browser.')) return;
        send('kick', { id: playerId });
        return $('#dlg-player').close();
      case 'create-from-notice':
        if (cfg.needsPassword) return (location.href = api('.'));
        return createRoom().then(goToRoom, (err) => toast(err.message, { error: true }));
      case 'reload':
        return location.reload();
    }
  });

  $('#invite').addEventListener('click', copyInvite);
  $('#settings-body').addEventListener('change', onSettingsChange);

  $('#name-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = $('#name-input').value.replace(/\s+/g, ' ').trim().slice(0, 20);
    if (!name) return $('#name-input').focus();
    store.set('name', name);
    const dialog = $('#dlg-name');
    dialog.close();
    if (dialog.dataset.rename && conn && state) send('rename', { name });
    else connect(currentRoomCode(), name);
  });
  // The name prompt can't be dismissed until you have a name.
  $('#dlg-name').addEventListener('cancel', (event) => {
    if (!$('#dlg-name').dataset.rename) event.preventDefault();
  });

  document.addEventListener('visibilitychange', updateTitle);
}

boot();
