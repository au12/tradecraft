import test from 'node:test';
import assert from 'node:assert/strict';
import * as game from '../server/game.js';

const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`);
const find = (round, pred) => round.cards.findIndex(pred);

test('classic distribution matches the board game at 5×5', () => {
  assert.deepEqual(game.distribution(25, 2, 1), { first: 9, other: 8, assassins: 1, neutral: 7 });
  const d4 = game.distribution(25, 4, 1);
  assert.equal(d4.first + d4.other * 3 + d4.assassins + d4.neutral, 25);
  const big = game.distribution(100, 3, 2);
  assert.equal(big.first + big.other * 2 + big.assassins + big.neutral, 100);
});

test('classic deal has the right number of every card', () => {
  for (const [cols, teams, assassins] of [[5, 2, 1], [4, 2, 1], [7, 3, 2], [10, 4, 3]]) {
    const ids = game.TEAM_IDS.slice(0, teams);
    const r = game.createClassicRound({ teams: ids, cols, words: words(cols * cols), assassins });
    const d = game.distribution(cols * cols, teams, assassins);
    assert.equal(r.cards.length, cols * cols);
    assert.equal(r.cards.filter((c) => c.owner === r.order[0]).length, d.first);
    for (const t of r.order.slice(1)) assert.equal(r.cards.filter((c) => c.owner === t).length, d.other);
    assert.equal(r.cards.filter((c) => c.owner === 'assassin').length, d.assassins);
    assert.equal(r.cards.filter((c) => c.owner === 'neutral').length, d.neutral);
  }
});

test('clue then guesses: limit is number + 1, wrong card passes the turn', () => {
  const r = game.createClassicRound({ teams: ['red', 'blue'], cols: 5, words: words(25), firstTeam: 'red' });
  assert.equal(game.currentTeam(r), 'red');
  assert.equal(game.guess(r, 'red', 0, 'x').ok, false, 'no guessing before a clue');
  assert.equal(game.giveClue(r, 'blue', { word: 'nope', count: 1 }, 'b').ok, false);
  assert.equal(game.giveClue(r, 'red', { word: 'ocean', count: 1 }, 'a').ok, true);
  assert.equal(r.phase, 'guess');
  assert.equal(r.guessesLeft, 2);
  assert.equal(game.guess(r, 'blue', 0, 'b').ok, false, 'wrong team cannot guess');

  const own = () => find(r, (c) => !c.revealed && c.owner === 'red');
  assert.ok(game.guess(r, 'red', own(), 'a').ok);
  assert.equal(r.phase, 'guess');
  assert.ok(game.guess(r, 'red', own(), 'a').ok);
  assert.equal(r.phase, 'clue', 'turn passes after number + 1 guesses');
  assert.equal(game.currentTeam(r), 'blue');
  assert.equal(r.remaining.red, 7);

  game.giveClue(r, 'blue', { word: 'sky', count: 'inf' }, 'b');
  assert.equal(r.guessesLeft, null);
  game.guess(r, 'blue', find(r, (c) => !c.revealed && c.owner === 'neutral'), 'b');
  assert.equal(game.currentTeam(r), 'red', 'a bystander ends the turn');
});

test('revealing the other team’s last card hands them the win', () => {
  const r = game.createClassicRound({ teams: ['red', 'blue'], cols: 5, words: words(25), firstTeam: 'red' });
  r.cards.forEach((c) => {
    if (c.owner === 'blue') c.revealed = true;
  });
  const last = find(r, (c) => c.owner === 'blue');
  r.cards[last].revealed = false;
  r.remaining.blue = 1;
  game.giveClue(r, 'red', { word: 'oops', count: 2 }, 'a');
  game.guess(r, 'red', last, 'a');
  assert.equal(r.phase, 'over');
  assert.equal(r.winner, 'blue');
  assert.equal(r.reason, 'gift');
});

test('assassin: two teams ends the game, more teams eliminates one', () => {
  const r2 = game.createClassicRound({ teams: ['red', 'blue'], cols: 5, words: words(25), firstTeam: 'red' });
  game.giveClue(r2, 'red', { word: 'x', count: 1 }, 'a');
  game.guess(r2, 'red', find(r2, (c) => c.owner === 'assassin'), 'a');
  assert.equal(r2.winner, 'blue');
  assert.equal(r2.reason, 'assassin');

  const r3 = game.createClassicRound({ teams: ['red', 'blue', 'green'], cols: 5, words: words(25), firstTeam: 'red', assassins: 2 });
  game.giveClue(r3, 'red', { word: 'x', count: 1 }, 'a');
  game.guess(r3, 'red', find(r3, (c) => c.owner === 'assassin'), 'a');
  assert.equal(r3.phase, 'clue');
  assert.deepEqual(r3.eliminated, ['red']);
  assert.equal(game.currentTeam(r3), 'blue');
  game.giveClue(r3, 'blue', { word: 'y', count: 1 }, 'b');
  game.endGuessing(r3, 'blue', 'b');
  assert.equal(game.currentTeam(r3), 'green');
  game.giveClue(r3, 'green', { word: 'z', count: 1 }, 'c');
  game.endGuessing(r3, 'green', 'c');
  assert.equal(game.currentTeam(r3), 'blue', 'eliminated team is skipped');
  game.giveClue(r3, 'blue', { word: 'w', count: 1 }, 'b');
  game.guess(r3, 'blue', find(r3, (c) => !c.revealed && c.owner === 'assassin'), 'b');
  assert.equal(r3.winner, 'green', 'last team standing wins');
});

test('clue validation', () => {
  const r = game.createClassicRound({ teams: ['red', 'blue'], cols: 5, words: ['Sun flower', 'cat', ...words(23)], firstTeam: 'red' });
  assert.ok(game.clueProblem(r, 'CAT', false));
  assert.ok(game.clueProblem(r, 'sunflower', false), 'ignores spaces and case');
  assert.equal(game.clueProblem(r, 'category', false), null);
  assert.ok(game.clueProblem(r, 'category', true), 'strict mode blocks clues containing a board word');
  assert.ok(game.clueProblem(r, 'flower', true), 'strict mode blocks parts of a board word');
  assert.equal(game.giveClue(r, 'red', { word: 'fine', count: 12 }, 'a').ok, false);
  assert.equal(game.giveClue(r, 'red', { word: '   ', count: 1 }, 'a').ok, false);
  r.cards[1].revealed = true;
  assert.equal(game.clueProblem(r, 'cat', true), null, 'revealed words are fair game');
});

test('marks are per card and cleared when the turn moves on', () => {
  const r = game.createClassicRound({ teams: ['red', 'blue'], cols: 5, words: words(25), firstTeam: 'red' });
  assert.equal(game.toggleMark(r, 'red', 3, 'p1').ok, false);
  game.giveClue(r, 'red', { word: 'x', count: 1 }, 'a');
  game.toggleMark(r, 'red', 3, 'p1');
  game.toggleMark(r, 'red', 3, 'p2');
  assert.deepEqual(r.marks[3], ['p1', 'p2']);
  game.toggleMark(r, 'red', 3, 'p1');
  assert.deepEqual(r.marks[3], ['p2']);
  game.endGuessing(r, 'red', 'a');
  assert.deepEqual(r.marks, {});
});

test('timeout passes the turn in either phase', () => {
  const r = game.createClassicRound({ teams: ['red', 'blue'], cols: 5, words: words(25), firstTeam: 'red' });
  game.timeout(r);
  assert.equal(game.currentTeam(r), 'blue');
  game.giveClue(r, 'blue', { word: 'x', count: 1 }, 'b');
  game.timeout(r);
  assert.equal(game.currentTeam(r), 'red');
  assert.equal(r.phase, 'clue');
});

test('co-op deal: 9 agents and 3 assassins per key, 15 agents overall', () => {
  for (let n = 0; n < 20; n++) {
    const r = game.createCoopRound({ teams: ['red', 'blue'], words: words(25) });
    for (const side of ['red', 'blue']) {
      assert.equal(r.cards.filter((c) => c.keys[side] === 'agent').length, 9);
      assert.equal(r.cards.filter((c) => c.keys[side] === 'assassin').length, 3);
    }
    assert.equal(r.cards.filter((c) => c.keys.red === 'agent' || c.keys.blue === 'agent').length, 15);
  }
});

test('co-op: guesses are judged on the clue-giver’s key and cost turns', () => {
  const r = game.createCoopRound({ teams: ['red', 'blue'], words: words(25), turns: 3, firstTeam: 'red' });
  assert.equal(game.giveClue(r, 'blue', { word: 'x', count: 1 }, 'b').ok, false);
  game.giveClue(r, 'red', { word: 'x', count: 2 }, 'a');
  assert.deepEqual(game.guessingTeams(r), ['blue']);
  assert.equal(game.guess(r, 'red', 0, 'a').ok, false, 'the clue-giver’s side does not guess');

  const agent = find(r, (c) => c.keys.red === 'agent' && !c.revealed);
  game.guess(r, 'blue', agent, 'b');
  assert.equal(r.cards[agent].revealed, true);
  assert.equal(r.agentsLeft, 14);
  assert.equal(r.phase, 'guess');

  const bystander = find(r, (c) => c.keys.red === 'neutral' && c.keys.blue !== 'assassin');
  game.guess(r, 'blue', bystander, 'b');
  assert.deepEqual(r.cards[bystander].miss, ['blue']);
  assert.equal(r.cards[bystander].revealed, false, 'the other side may still try this card');
  assert.equal(r.tokens, 2);
  assert.equal(game.currentTeam(r), 'blue', 'clue duty swaps');
  assert.equal(game.guess(r, 'blue', bystander, 'b').ok, false);

  game.giveClue(r, 'blue', { word: 'y', count: 1 }, 'b');
  game.guess(r, 'red', find(r, (c) => c.keys.blue === 'assassin' && !c.revealed), 'a');
  assert.equal(r.phase, 'over');
  assert.equal(r.outcome, 'lose');
});

test('co-op: running out of turns starts sudden death; a miss then loses', () => {
  const r = game.createCoopRound({ teams: ['red', 'blue'], words: words(25), turns: 1, firstTeam: 'red' });
  game.giveClue(r, 'red', { word: 'x', count: 1 }, 'a');
  game.endGuessing(r, 'blue', 'b');
  assert.equal(r.sudden, true);
  assert.equal(r.phase, 'guess');
  assert.deepEqual(game.guessingTeams(r).sort(), ['blue', 'red']);
  assert.equal(game.giveClue(r, 'blue', { word: 'y', count: 1 }, 'b').ok, false);
  assert.equal(game.endGuessing(r, 'red', 'a').ok, false);
  // Red guesses a card that is an agent on blue's key: still fine.
  game.guess(r, 'red', find(r, (c) => c.keys.blue === 'agent' && !c.revealed), 'a');
  assert.equal(r.phase, 'guess');
  game.guess(r, 'red', find(r, (c) => c.keys.blue === 'neutral' && !c.revealed), 'a');
  assert.equal(r.outcome, 'lose');
  assert.equal(r.reason, 'time');
});

test('co-op: finding all 15 agents wins', () => {
  const r = game.createCoopRound({ teams: ['red', 'blue'], words: words(25), turns: 11, firstTeam: 'red' });
  let safety = 0;
  while (r.phase !== 'over' && safety++ < 60) {
    const cluer = game.currentTeam(r);
    const guesser = cluer === 'red' ? 'blue' : 'red';
    assert.ok(game.giveClue(r, cluer, { word: `clue${safety}`, count: 'inf' }, cluer).ok);
    let idx;
    while (r.phase === 'guess' && (idx = find(r, (c) => !c.revealed && c.keys[cluer] === 'agent')) !== -1) {
      game.guess(r, guesser, idx, guesser);
    }
    if (r.phase === 'guess') game.endGuessing(r, guesser, guesser);
  }
  assert.equal(r.outcome, 'win');
  assert.equal(r.agentsLeft, 0);
});
