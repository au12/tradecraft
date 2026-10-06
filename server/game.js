// Rules engine. Pure functions over a plain "round" object — no sockets, no
// timers, no I/O — so it can be unit-tested and persisted as JSON.
//
// Two modes:
//   classic  2–4 teams race to uncover their own agents. One spymaster per
//            team gives clues; operatives guess.
//   coop     Two sides share one board but hold different keys. Each side
//            gives clues for the agents on its own key; the other side guesses.
//            Everyone wins or loses together.

import { randomInt, randomUUID } from 'node:crypto';

export const TEAM_IDS = ['red', 'blue', 'green', 'yellow'];
export const NEUTRAL = 'neutral';
export const ASSASSIN = 'assassin';
export const AGENT = 'agent';

export const COOP_COLS = 5;
export const COOP_AGENTS = 15;

/** Fisher–Yates using a crypto-backed integer source (injectable for tests). */
export function shuffle(list, rnd = randomInt) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * How many cards of each kind go on a classic board.
 * The starting team gets one extra card; whatever is left over is bystanders.
 */
export function distribution(total, teamCount, assassins = 1) {
  const first = Math.floor(total / (teamCount + 1)) + 1;
  const other = first - 1;
  const teamCards = first + other * (teamCount - 1);
  const killers = Math.max(0, Math.min(assassins, total - teamCards));
  return { first, other, assassins: killers, neutral: total - teamCards - killers };
}

function baseRound({ mode, cols, order }) {
  return {
    id: randomUUID().slice(0, 8),
    mode,
    cols,
    rows: cols,
    order,
    turn: 0,
    phase: 'clue', // clue | guess | over
    clue: null,
    clueNo: 0,
    guessesLeft: null, // null = unlimited
    guessesMade: 0,
    marks: {}, // card index -> [playerId]
    log: [],
    winner: null,
    outcome: null, // coop: win | lose
    reason: null,
    deadline: null,
    pausedLeft: null,
    startedAt: Date.now(),
    endedAt: null,
  };
}

export function createClassicRound({ teams, cols, words, assassins = 1, firstTeam, rnd = randomInt }) {
  const total = cols * cols;
  if (words.length < total) throw new Error('Not enough words for this board');
  if (teams.length < 2) throw new Error('Classic needs at least two teams');

  const start = firstTeam && teams.includes(firstTeam) ? firstTeam : teams[rnd(teams.length)];
  const at = teams.indexOf(start);
  const order = [...teams.slice(at), ...teams.slice(0, at)];

  const d = distribution(total, teams.length, assassins);
  const owners = [];
  order.forEach((team, i) => {
    for (let n = 0; n < (i === 0 ? d.first : d.other); n++) owners.push(team);
  });
  for (let n = 0; n < d.assassins; n++) owners.push(ASSASSIN);
  while (owners.length < total) owners.push(NEUTRAL);
  const dealt = shuffle(owners, rnd);

  const round = baseRound({ mode: 'classic', cols, order });
  round.cards = words.slice(0, total).map((word, i) => ({ word, owner: dealt[i], revealed: false, by: null }));
  round.remaining = Object.fromEntries(order.map((team, i) => [team, i === 0 ? d.first : d.other]));
  round.eliminated = [];
  return round;
}

// The 25 key pairs for a co-op board: [what side A sees, what side B sees].
// Each side sees 9 agents and 3 assassins; 3 agents are shared, so there are
// 15 distinct agents to find.
const COOP_PAIRS = [
  ...Array(3).fill([AGENT, AGENT]),
  [ASSASSIN, ASSASSIN],
  [ASSASSIN, AGENT],
  [AGENT, ASSASSIN],
  [ASSASSIN, NEUTRAL],
  [NEUTRAL, ASSASSIN],
  ...Array(5).fill([AGENT, NEUTRAL]),
  ...Array(5).fill([NEUTRAL, AGENT]),
  ...Array(7).fill([NEUTRAL, NEUTRAL]),
];

export function createCoopRound({ teams, words, turns = 9, firstTeam, rnd = randomInt }) {
  const total = COOP_COLS * COOP_COLS;
  if (words.length < total) throw new Error('Not enough words for this board');
  if (teams.length !== 2) throw new Error('Co-op needs exactly two sides');
  const [a, b] = teams;
  const start = firstTeam && teams.includes(firstTeam) ? firstTeam : teams[rnd(2)];
  const order = start === a ? [a, b] : [b, a];

  const pairs = shuffle(COOP_PAIRS, rnd);
  const round = baseRound({ mode: 'coop', cols: COOP_COLS, order });
  round.cards = words.slice(0, total).map((word, i) => ({
    word,
    keys: { [a]: pairs[i][0], [b]: pairs[i][1] },
    revealed: false, // true once it is a found agent, or the assassin that ended the game
    result: null,
    miss: [], // sides that guessed this card and hit a bystander
    by: null,
  }));
  round.tokens = turns;
  round.turnsTotal = turns;
  round.sudden = false;
  round.agentsLeft = COOP_AGENTS;
  return round;
}

// ───────────────────────────── helpers ─────────────────────────────

const fail = (error) => ({ ok: false, error });
const ok = (events = []) => ({ ok: true, events });

export function currentTeam(round) {
  return round.order[round.turn];
}

function otherSide(round, side) {
  return round.order.find((t) => t !== side);
}

/** The team whose members may guess right now (null if nobody may). */
export function guessingTeams(round) {
  if (round.phase !== 'guess') return [];
  if (round.mode === 'classic') return [currentTeam(round)];
  if (round.sudden) return round.order.slice();
  return [otherSide(round, currentTeam(round))];
}

function log(round, entry) {
  round.log.push({ at: Date.now(), ...entry });
  if (round.log.length > 600) round.log.splice(0, round.log.length - 600);
}

function finish(round, fields) {
  Object.assign(round, fields);
  round.phase = 'over';
  round.clue = null;
  round.marks = {};
  round.deadline = null;
  round.pausedLeft = null;
  round.endedAt = Date.now();
  log(round, { type: 'end', winner: round.winner, outcome: round.outcome, reason: round.reason });
}

const norm = (s) => String(s).toUpperCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Returns a human-readable reason if the clue is not allowed, else null.
 * A clue may never be a word that is still face-down on the board; in strict
 * mode it also may not contain one (or be contained in one).
 */
export function clueProblem(round, word, strict) {
  const clue = norm(word);
  if (!clue) return 'Type a clue first.';
  for (const card of round.cards) {
    if (card.revealed) continue;
    const w = norm(card.word);
    if (!w) continue;
    if (clue === w) return `“${card.word}” is on the board — pick a different clue.`;
    if (strict) {
      if (w.length >= 3 && clue.includes(w)) return `That clue contains “${card.word}”, which is on the board.`;
      if (clue.length >= 4 && w.includes(clue)) return `That clue is part of “${card.word}”, which is on the board.`;
    }
  }
  return null;
}

function parseCount(count) {
  if (count === 'inf' || count === '∞') return { ok: true, value: 'inf', limit: null };
  const n = Number(count);
  if (!Number.isInteger(n) || n < 0 || n > 9) return { ok: false };
  // "0" means "none of ours relate to this" — guesses are unlimited.
  return { ok: true, value: n, limit: n === 0 ? null : n + 1 };
}

// ───────────────────────────── actions ─────────────────────────────

export function giveClue(round, team, { word, count }, by, { strict = false } = {}) {
  if (round.phase !== 'clue') return fail('It is not time for a clue.');
  if (round.mode === 'coop' && round.sudden) return fail('No more clues — it is sudden death.');
  if (currentTeam(round) !== team) return fail('It is not your turn to give a clue.');
  const text = String(word ?? '').trim().replace(/\s+/g, ' ');
  if (text.length > 30) return fail('Keep the clue under 30 characters.');
  const problem = clueProblem(round, text, strict);
  if (problem) return fail(problem);
  const c = parseCount(count);
  if (!c.ok) return fail('Pick a number from 0 to 9, or ∞.');

  round.clueNo += 1;
  round.clue = { word: text.toUpperCase(), count: c.value, team, by, no: round.clueNo };
  round.phase = 'guess';
  round.guessesLeft = c.limit;
  round.guessesMade = 0;
  round.marks = {};
  log(round, { type: 'clue', team, by, word: round.clue.word, count: c.value, no: round.clueNo });
  return ok([{ type: 'clue' }]);
}

function nextClassicTurn(round) {
  const n = round.order.length;
  for (let step = 1; step <= n; step++) {
    const idx = (round.turn + step) % n;
    if (!round.eliminated.includes(round.order[idx])) {
      round.turn = idx;
      break;
    }
  }
  round.phase = 'clue';
  round.clue = null;
  round.guessesLeft = null;
  round.guessesMade = 0;
  round.marks = {};
}

function classicGuess(round, team, index, by) {
  const card = round.cards[index];
  card.revealed = true;
  card.by = team;
  round.marks = {};
  const owner = card.owner;
  log(round, { type: 'guess', team, by, word: card.word, result: owner, no: round.clueNo });
  const events = [{ type: 'reveal', index, result: owner, team }];

  if (owner === ASSASSIN) {
    round.eliminated.push(team);
    const alive = round.order.filter((t) => !round.eliminated.includes(t));
    if (alive.length === 1) {
      finish(round, { winner: alive[0], reason: 'assassin', loser: team });
    } else {
      log(round, { type: 'eliminated', team });
      nextClassicTurn(round);
    }
    return ok(events);
  }

  if (owner === NEUTRAL) {
    nextClassicTurn(round);
    return ok(events);
  }

  // A team's card.
  round.remaining[owner] -= 1;
  if (round.remaining[owner] === 0 && !round.eliminated.includes(owner)) {
    finish(round, { winner: owner, reason: owner === team ? 'agents' : 'gift' });
    return ok(events);
  }
  if (owner !== team) {
    nextClassicTurn(round);
    return ok(events);
  }
  round.guessesMade += 1;
  if (round.guessesLeft !== null) {
    round.guessesLeft -= 1;
    if (round.guessesLeft <= 0) nextClassicTurn(round);
  }
  return ok(events);
}

function coopAgentsToClue(round, side) {
  return round.cards.filter((c) => !c.revealed && c.keys[side] === AGENT).length;
}

function endCoopTurn(round) {
  round.tokens -= 1;
  round.clue = null;
  round.guessesLeft = null;
  round.guessesMade = 0;
  round.marks = {};
  if (round.tokens <= 0) {
    round.tokens = 0;
    round.sudden = true;
    round.phase = 'guess';
    log(round, { type: 'sudden' });
    return;
  }
  // Clue duty alternates, unless the other side has nothing left to clue.
  const next = otherSide(round, currentTeam(round));
  if (coopAgentsToClue(round, next) > 0) round.turn = round.order.indexOf(next);
  round.phase = 'clue';
}

function coopGuess(round, side, index, by) {
  const card = round.cards[index];
  if (card.miss.includes(side)) return fail('Your side already tried that card.');
  // A guess is always judged against the *other* side's key.
  const result = card.keys[otherSide(round, side)];
  round.marks = {};
  log(round, { type: 'guess', team: side, by, word: card.word, result, no: round.clueNo });
  const events = [{ type: 'reveal', index, result, team: side }];

  if (result === ASSASSIN) {
    card.revealed = true;
    card.result = ASSASSIN;
    card.by = side;
    finish(round, { outcome: 'lose', reason: 'assassin' });
    return ok(events);
  }
  if (result === AGENT) {
    card.revealed = true;
    card.result = AGENT;
    card.by = side;
    round.agentsLeft -= 1;
    round.guessesMade += 1;
    if (round.agentsLeft === 0) {
      finish(round, { outcome: 'win', reason: 'agents' });
    } else if (round.guessesLeft !== null) {
      round.guessesLeft -= 1;
      if (round.guessesLeft <= 0 && !round.sudden) endCoopTurn(round);
    }
    return ok(events);
  }
  // Bystander.
  card.miss.push(side);
  if (round.sudden) {
    finish(round, { outcome: 'lose', reason: 'time' });
  } else {
    endCoopTurn(round);
  }
  return ok(events);
}

export function guess(round, team, index, by) {
  if (round.phase !== 'guess') return fail('Wait for the clue.');
  if (!guessingTeams(round).includes(team)) return fail('It is not your turn to guess.');
  const card = round.cards[index];
  if (!card) return fail('No such card.');
  if (card.revealed) return fail('That card is already revealed.');
  return round.mode === 'classic' ? classicGuess(round, team, index, by) : coopGuess(round, team, index, by);
}

export function endGuessing(round, team, by) {
  if (round.phase !== 'guess') return fail('There is nothing to end right now.');
  if (round.mode === 'coop' && round.sudden) return fail('Sudden death — keep guessing until every agent is found.');
  if (!guessingTeams(round).includes(team)) return fail('It is not your turn.');
  log(round, { type: 'pass', team, by, no: round.clueNo });
  if (round.mode === 'classic') nextClassicTurn(round);
  else endCoopTurn(round);
  return ok([{ type: 'pass' }]);
}

/** The turn timer ran out. */
export function timeout(round) {
  if (round.phase === 'over') return fail('Round is over.');
  if (round.mode === 'coop' && round.sudden) return fail('No timer in sudden death.');
  const team = round.phase === 'clue' ? currentTeam(round) : guessingTeams(round)[0];
  log(round, { type: 'timeout', team, phase: round.phase });
  if (round.mode === 'classic') nextClassicTurn(round);
  else endCoopTurn(round);
  return ok([{ type: 'timeout' }]);
}

/** A guesser points at a card (or stops pointing) so teammates can see. */
export function toggleMark(round, team, index, playerId) {
  if (round.phase !== 'guess') return fail('Wait for the clue.');
  if (!guessingTeams(round).includes(team)) return fail('It is not your turn to guess.');
  const card = round.cards[index];
  if (!card || card.revealed) return fail('That card is already revealed.');
  if (round.mode === 'coop' && card.miss.includes(team)) return fail('Your side already tried that card.');
  const list = round.marks[index] ?? [];
  round.marks[index] = list.includes(playerId) ? list.filter((p) => p !== playerId) : [...list, playerId];
  if (round.marks[index].length === 0) delete round.marks[index];
  return ok();
}

export function removeMarksOf(round, playerId) {
  for (const key of Object.keys(round.marks)) {
    round.marks[key] = round.marks[key].filter((p) => p !== playerId);
    if (round.marks[key].length === 0) delete round.marks[key];
  }
}

/** Host ended the round early. */
export function abandon(round) {
  if (round.phase === 'over') return;
  finish(round, { reason: 'abandoned', outcome: round.mode === 'coop' ? 'lose' : null });
}
