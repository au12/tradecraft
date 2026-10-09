// Everything around the board: team panels, spectators, host controls, the
// log, and the status strip above the board.

import { $, esc, icon } from './util.js';

const teamName = (state, id) => state.teams.find((t) => t.id === id)?.name ?? id;
const isLive = (state) => Boolean(state.round && state.round.phase !== 'over');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Whose move is it, in terms of team panels to highlight. */
function activeTeams(round) {
  if (!round || round.phase === 'over') return [];
  return round.phase === 'clue' ? [round.turn] : round.guessing;
}

/** True when the viewer personally has something to do right now. */
export function myMove(state, me) {
  const r = state.round;
  if (!r || r.phase === 'over' || !me.teams.length) return false;
  if (r.mode === 'coop') {
    const side = me.teams[0];
    return r.phase === 'clue' ? r.turn === side && !r.sudden : r.guessing.includes(side);
  }
  if (r.phase === 'clue') return me.teams.includes(r.turn) && me.role === 'spymaster';
  return r.guessing.some((t) => me.teams.includes(t)) && me.role === 'operative';
}

/** What still has to happen before the host can start. */
export function startProblems(state) {
  const problems = [];
  const coop = state.settings.mode === 'coop';
  for (const team of state.teams) {
    const members = state.players.filter((p) => p.teams.includes(team.id));
    if (coop) {
      if (members.length === 0) problems.push(`${team.name} needs a player`);
    } else {
      if (!members.some((p) => p.role === 'spymaster')) problems.push(`${team.name} needs a spymaster`);
      if (!members.some((p) => p.role === 'operative')) problems.push(`${team.name} needs an operative`);
    }
  }
  if (state.poolSize < state.cardsNeeded) problems.push(`the word packs only have ${state.poolSize} of the ${state.cardsNeeded} words this board needs`);
  return problems;
}

// ───────────────────────── rails ─────────────────────────

function playerChip(state, me, p) {
  const host = me.id === state.hostId;
  const cls = `player${p.id === me.id ? ' is-you' : ''}${p.online ? '' : ' is-offline'}`;
  const inner = `${p.id === state.hostId ? icon('crown') : ''}<span>${esc(p.name)}</span>`;
  const title = `${p.name}${p.id === state.hostId ? ' (host)' : ''}${p.online ? '' : ', offline'}`;
  return host
    ? `<button type="button" class="${cls}" data-act="player" data-id="${esc(p.id)}" title="${esc(title)}">${inner}</button>`
    : `<span class="${cls}" title="${esc(title)}">${inner}</span>`;
}

function teamPanel(state, me, team) {
  const r = state.round;
  const coop = state.settings.mode === 'coop';
  const members = state.players.filter((p) => p.teams.includes(team.id));
  const chips = (list) => list.map((p) => playerChip(state, me, p)).join('');
  const turn = activeTeams(r).includes(team.id);
  const out = r?.eliminated?.includes(team.id);
  const mine = me.teams.includes(team.id);
  const btn = (act, role, label, title = '') =>
    `<button type="button" class="btn btn-small" data-act="${act}" data-team="${team.id}" data-role="${role}"${title ? ` title="${esc(title)}"` : ''}>${label}</button>`;
  // Someone already seated in this role elsewhere can either move here or
  // take this team on as well. Mixing roles across teams is not allowed.
  const joinButtons = (role, label) =>
    me.teams.length && !mine && me.role === role
      ? `<div class="seat-actions">
          ${btn('join', role, 'Move here', 'Leave your current team and join this one')}
          ${btn('join-also', role, 'Also join', 'Stay where you are and play for this team too')}
        </div>`
      : btn('join', role, label);
  const leave = mine && me.teams.length > 1 ? btn('leave', '', `Leave ${esc(team.name)}`) : '';

  let body;
  if (coop) {
    body = `<div>
        <div class="seat-label">Players</div>
        <div class="seat-list">${chips(members) || '<span class="seat-empty">Nobody yet</span>'}</div>
      </div>
      ${mine ? '' : btn('join', 'operative', `Join ${esc(team.name)}`)}`;
  } else {
    const spies = members.filter((p) => p.role === 'spymaster');
    const ops = members.filter((p) => p.role !== 'spymaster');
    const iAmSpy = mine && me.role === 'spymaster';
    const iAmOp = mine && me.role === 'operative';
    const seatFree = spies.length === 0 || spies.every((p) => !p.online);
    body = `<div>
        <div class="seat-label">Spymaster</div>
        <div class="seat-list">${chips(spies) || '<span class="seat-empty">Open seat</span>'}</div>
      </div>
      ${!iAmSpy && seatFree ? joinButtons('spymaster', 'Join as spymaster') : ''}
      <div>
        <div class="seat-label">Operatives</div>
        <div class="seat-list">${chips(ops) || '<span class="seat-empty">Nobody yet</span>'}</div>
      </div>
      ${iAmOp ? '' : joinButtons('operative', 'Join as operative')}
      ${leave}`;
  }

  const count = !coop && r ? `<span class="team-count" title="Cards left to find">${r.remaining[team.id] ?? ''}</span>` : '';
  const foot = coop ? '' : `<div class="team-foot"><span>${out ? 'Out this round' : turn ? 'Their turn' : ''}</span><span>${plural(team.wins, 'win')}</span></div>`;
  return `<section class="team${turn ? ' is-turn' : ''}${out ? ' is-out' : ''}" data-team="${team.id}" aria-label="${esc(team.name)} team">
      <header class="team-head">${icon(team.id)}<h2 class="team-name">${esc(team.name)}</h2>${count}</header>
      <div class="team-body">${body}</div>
      ${foot}
    </section>`;
}

function spectatorsPanel(state, me) {
  const watching = state.players.filter((p) => !p.teams.length);
  return `<section class="side">
      <h2>Spectators</h2>
      <div class="seat-list">${watching.map((p) => playerChip(state, me, p)).join('') || '<span class="seat-empty">Nobody is just watching</span>'}</div>
      ${me.teams.length ? '<button type="button" class="btn btn-small" data-act="spectate">Watch instead</button>' : ''}
    </section>`;
}

function hostPanel(state) {
  const live = isLive(state);
  const buttons = [];
  if (!live) buttons.push('<button type="button" class="btn btn-small" data-act="shuffle">Shuffle teams</button>');
  if (live) buttons.push('<button type="button" class="btn btn-small" data-act="end-round">End round</button>');
  if (state.round) buttons.push('<button type="button" class="btn btn-small" data-act="lobby">Back to lobby</button>');
  buttons.push(
    `<button type="button" class="btn btn-small" data-act="lock" aria-pressed="${state.locked}">${icon('lock')}${state.locked ? 'Unlock room' : 'Lock room'}</button>`,
  );
  return `<section class="side">
      <h2>Host controls</h2>
      <div class="set-actions">${buttons.join('')}</div>
      <p class="set-hint">Click a player’s name to move or remove them.</p>
    </section>`;
}

function logEntry(state, e) {
  const who = esc(e.by ?? '');
  switch (e.type) {
    case 'clue':
      return `<li class="log-clue" data-team="${e.team}">${who}: <b>${esc(e.word)} ${e.count === 'inf' ? '∞' : e.count}</b></li>`;
    case 'guess':
      return `<li class="log-guess">${who} picked <span class="tag" data-kind="${e.result}">${esc(e.word)}</span></li>`;
    case 'pass':
      return `<li class="log-note">${who} ended the guessing</li>`;
    case 'timeout':
      return `<li class="log-note">Time ran out for ${esc(teamName(state, e.team))}</li>`;
    case 'eliminated':
      return `<li class="log-note">${esc(teamName(state, e.team))} hit an assassin and is out</li>`;
    case 'sudden':
      return '<li class="log-end">Out of turns: sudden death</li>';
    case 'end':
      if (e.reason === 'abandoned') return '<li class="log-end">The host ended the round</li>';
      if (e.winner) return `<li class="log-end">${esc(teamName(state, e.winner))} wins</li>`;
      return `<li class="log-end">${e.outcome === 'win' ? 'Mission complete' : 'Mission failed'}</li>`;
    default:
      return '';
  }
}

function logPanel(state) {
  const entries = state.round?.log ?? [];
  return `<section class="side">
      <div class="side-row"><h2>Log</h2>${state.roundNo ? `<span class="set-hint">Round ${state.roundNo}</span>` : ''}</div>
      <ol class="log" id="log">${entries.map((e) => logEntry(state, e)).join('') || '<li class="log-empty">Clues and guesses show up here.</li>'}</ol>
    </section>`;
}

function coopPanel(state) {
  const r = state.round;
  if (state.settings.mode !== 'coop') return '';
  const total = r?.turnsTotal ?? state.settings.coopTurns;
  const left = r ? r.tokens : total;
  const pips = Array.from({ length: total }, (_, i) => `<i class="${i < left ? '' : 'spent'}"></i>`).join('');
  return `<section class="side">
      <h2>Mission</h2>
      <div class="side-row"><span>Agents found</span><b>${r ? 15 - r.agentsLeft : 0} of 15</b></div>
      <div class="side-row"><span>Turns left</span><span class="pips" title="${left} of ${total}">${pips}</span></div>
      <div class="side-row side-meta"><span>Record</span><span>${plural(state.coop.wins, 'win')}, ${plural(state.coop.losses, 'loss', 'losses')}</span></div>
    </section>`;
}

export function renderRails(state, me) {
  const half = Math.ceil(state.teams.length / 2);
  const left = state.teams.slice(0, half);
  const right = state.teams.slice(half);
  const isHost = me.id === state.hostId;

  const oldLog = $('#log');
  const stick = !oldLog || oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight < 40;

  $('#rail-left').innerHTML =
    left.map((t) => teamPanel(state, me, t)).join('') + coopPanel(state) + spectatorsPanel(state, me) + (isHost ? hostPanel(state) : '');
  $('#rail-right').innerHTML = right.map((t) => teamPanel(state, me, t)).join('') + logPanel(state);

  const log = $('#log');
  if (stick) log.scrollTop = log.scrollHeight;
}

// ───────────────────────── status strip ─────────────────────────

function guessesText(r) {
  if (r.guessesLeft == null) return 'Unlimited guesses';
  return `${plural(r.guessesLeft, 'guess', 'guesses')} left`;
}

function clueBlock(r) {
  return `<div class="clue" data-team="${r.clue.team}">
      <span class="clue-word">${esc(r.clue.word)}</span>
      <span class="clue-count">${r.clue.count === 'inf' ? '∞' : r.clue.count}</span>
    </div>`;
}

function statusModel(state, me) {
  const r = state.round;
  const isHost = me.id === state.hostId;
  const hostName = state.players.find((p) => p.id === state.hostId)?.name ?? 'the host';
  const name = (id) => teamName(state, id);
  const coop = state.settings.mode === 'coop';
  const startButtons = (label) =>
    `<button type="button" class="btn btn-primary" data-act="start">${label}</button>
     <button type="button" class="btn" data-act="start-shuffle">Shuffle teams and ${label.toLowerCase().startsWith('play') ? 'play' : 'start'}</button>`;

  // ── lobby ──
  if (!r) {
    const problems = startProblems(state);
    const waiting = problems.length ? `Still needed: ${problems.join(', ')}.` : 'Everyone is seated.';
    if (isHost) {
      return {
        title: problems.length ? 'Fill the seats, then start' : 'Ready when you are',
        sub: waiting,
        actions: `<button type="button" class="btn btn-primary" data-act="start"${problems.length ? ' disabled' : ''}>Start game</button>
          <button type="button" class="btn" data-act="start-shuffle">Shuffle teams and start</button>`,
      };
    }
    return {
      title: me.teams.length ? `Waiting for ${hostName} to start` : 'Pick a team to join',
      sub: waiting,
    };
  }

  // ── round over ──
  if (r.phase === 'over') {
    let title;
    let sub;
    if (r.reason === 'abandoned') {
      title = 'Round ended early';
      sub = 'The cards below show what was where.';
    } else if (coop) {
      title = r.outcome === 'win' ? 'Mission complete' : r.reason === 'assassin' ? 'Mission failed' : 'Out of time';
      sub =
        r.outcome === 'win'
          ? `All 15 agents found with ${plural(r.tokens, 'turn')} to spare.`
          : r.reason === 'assassin'
            ? 'That card was an assassin.'
            : `A wrong card in sudden death. ${r.agentsLeft} of 15 agents were still out there.`;
      sub += ` Each card’s band shows ${name(state.teams[0].id)}’s key on the left and ${name(state.teams[1].id)}’s on the right.`;
    } else {
      title = `${name(r.winner)} wins`;
      sub =
        r.reason === 'assassin'
          ? `${name(r.loser)} found the assassin.`
          : r.reason === 'gift'
            ? 'The other team revealed their last agent for them.'
            : 'Every one of their agents is in.';
    }
    if (!isHost) sub += ` ${hostName} can start the next round.`;
    return { team: r.winner, title, sub, actions: isHost ? startButtons('Play again') : '' };
  }

  const mine = myMove(state, me);

  // ── co-op ──
  if (coop) {
    const guessers = r.guessing.map(name).join(' and ');
    if (r.sudden) {
      return {
        title: 'Sudden death',
        sub: mine
          ? 'No more clues. Tap a card, then Reveal. One wrong card ends the game.'
          : 'No more clues. One wrong card ends the game.',
      };
    }
    if (r.phase === 'clue') {
      const other = name(r.order.find((t) => t !== r.turn));
      if (mine) return { team: r.turn, form: true, title: `Give ${other} a clue`, sub: 'Point them at the green cards on your key.' };
      return { team: r.turn, title: `${name(r.turn)} is thinking of a clue`, sub: me.teams.length ? 'Your key stays secret. No hints.' : '' };
    }
    return {
      team: r.guessing[0],
      html: clueBlock(r),
      sub: mine ? `${guessesText(r)}. Tap a card to point at it, then Reveal.` : `${guessers} is guessing. ${guessesText(r)}.`,
      actions: mine ? '<button type="button" class="btn" data-act="end-guess">End guessing</button>' : '',
    };
  }

  // ── classic ──
  if (r.phase === 'clue') {
    if (mine) {
      return {
        team: r.turn,
        form: true,
        title: me.teams.length > 1 ? `Give ${name(r.turn)} a clue` : 'Give your team a clue',
        sub: `One word, then how many cards it points to. ${plural(r.remaining[r.turn], 'card')} left to find.`,
      };
    }
    const spy = state.players.find((p) => p.teams.includes(r.turn) && p.role === 'spymaster');
    if (!spy) {
      return { team: r.turn, title: `${name(r.turn)} needs a spymaster`, sub: 'The seat is open. Someone on the team can take it, or the host can assign it.' };
    }
    return {
      team: r.turn,
      title: `${spy.name} is thinking of a clue`,
      sub: me.teams.includes(r.turn) ? `${me.teams.length > 1 ? name(r.turn) : 'Your team'} is up next.` : `${name(r.turn)}’s turn.`,
    };
  }
  return {
    team: r.turn,
    html: clueBlock(r),
    sub: mine
      ? `${me.teams.length > 1 ? `Guessing for ${name(r.turn)}. ` : ''}${guessesText(r)}. Tap a card to point at it, then Reveal.`
      : `${name(r.turn)} is guessing. ${guessesText(r)}.`,
    actions: mine ? '<button type="button" class="btn" data-act="end-guess">End guessing</button>' : '',
  };
}

export function renderStatus(state, me) {
  const m = statusModel(state, me);
  const el = $('#status');
  if (m.team) el.dataset.team = m.team;
  else delete el.dataset.team;

  const head = m.html ?? `<div class="status-title">${esc(m.title)}</div>`;
  $('#status-text').innerHTML = `${head}${m.sub ? `<div class="status-sub">${esc(m.sub)}</div>` : ''}`;
  $('#status-actions').innerHTML = m.actions ?? '';

  const form = $('#clue-form');
  const show = Boolean(m.form);
  if (form.hidden === show) {
    form.hidden = !show;
    if (show) {
      form.reset();
      $('#clue-counts input[value="1"]').checked = true;
      if (matchMedia('(pointer: fine)').matches) $('#clue-word').focus({ preventScroll: true });
    }
  }
  form.querySelector('button[type="submit"]').className = `btn ${m.team ? 'btn-team' : 'btn-primary'}`;
}
