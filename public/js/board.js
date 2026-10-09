// The grid of word cards. Cells are built once per round and then patched in
// place, so the reveal transition can play and focus is never lost.

import { $, esc, icon, initials } from './util.js';

const ROW_LABELS = 'ABCDEFGHIJ';
const KEY_COLORS = { agent: 'var(--green)', neutral: 'var(--sand)', assassin: 'var(--black)' };

/** Picks a width and size class so that long words still fit on one card. */
function fitFor(word) {
  const longest = Math.max(...word.split(/\s+/).map((w) => w.length));
  if (word.includes(' ') && word.length > 11) return { fit: 'xl', len: Math.max(longest, Math.ceil(word.length / 2)) };
  if (word.length <= 5) return { fit: 's', len: word.length };
  if (word.length <= 8) return { fit: 'm', len: word.length };
  return { fit: 'l', len: word.length };
}

export const coord = (i, cols) => `${ROW_LABELS[Math.floor(i / cols)]}${(i % cols) + 1}`;

function setAxes(cols, rows) {
  const wrap = $('#board-wrap');
  if (wrap.dataset.dim === `${cols}x${rows}`) return;
  wrap.dataset.dim = `${cols}x${rows}`;
  wrap.style.setProperty('--cols', cols);
  wrap.style.setProperty('--rows', rows);
  $('#axis-cols').innerHTML = Array.from({ length: cols }, (_, i) => `<span>${i + 1}</span>`).join('');
  $('#axis-rows').innerHTML = Array.from({ length: rows }, (_, i) => `<span>${ROW_LABELS[i]}</span>`).join('');
}

function build(board, round) {
  board.innerHTML = round.cards
    .map((c, i) => {
      const { fit, len } = fitFor(c.w);
      return `<div class="cell" data-fit="${fit}" style="--len:${len}">
        <button class="card" type="button" data-i="${i}">
          <span class="card-marks"></span>
          <span class="card-word">${esc(c.w)}</span>
          <span class="card-shape"></span>
          <span class="card-miss"></span>
        </button>
      </div>`;
    })
    .join('');
  board.dataset.round = round.id;
}

function setAttr(el, name, value) {
  if (value == null || value === '') {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== String(value)) {
    el.setAttribute(name, value);
  }
}

function setHtml(el, html) {
  if (el._html !== html) {
    el.innerHTML = html;
    el._html = html;
  }
}

const KIND_WORDS = {
  red: 'red agent', blue: 'blue agent', green: 'green agent', yellow: 'yellow agent',
  agent: 'agent', neutral: 'bystander', assassin: 'assassin',
};

export function renderBoard(state, me) {
  const board = $('#board');
  const round = state.round;

  if (!round) {
    const cols = state.settings.mode === 'coop' ? 5 : state.settings.cols;
    setAxes(cols, cols);
    board.className = `board ghost${cols > 7 ? ' is-large' : ''}`;
    if (board.dataset.round !== `ghost-${cols}`) {
      board.innerHTML = Array.from({ length: cols * cols }, () => '<div class="cell"><div class="card"></div></div>').join('');
      board.dataset.round = `ghost-${cols}`;
    }
    return;
  }

  setAxes(round.cols, round.rows);
  if (board.dataset.round !== round.id) build(board, round);

  const over = round.phase === 'over';
  const coop = round.mode === 'coop';
  const side = me.teams[0]; // co-op: one side per person
  const canGuess =
    round.phase === 'guess' &&
    (coop ? round.guessing.includes(side) : me.role === 'operative' && round.guessing.some((t) => me.teams.includes(t)));
  const keyView = !over && round.cards.some((c) => c.k !== undefined);
  board.className = `board${round.cols > 7 ? ' is-large' : ''}${keyView ? ' is-keyview' : ''}`;
  const names = new Map(state.players.map((p) => [p.id, p.name]));
  const [sideA, sideB] = round.order.slice().sort((a, b) => state.teams.findIndex((t) => t.id === a) - state.teams.findIndex((t) => t.id === b));

  round.cards.forEach((c, i) => {
    const cell = board.children[i];
    const card = cell.firstElementChild;
    const tried = coop && !c.r && c.x?.includes(side);
    const pickable = canGuess && !c.r && !tried;
    const mine = Boolean(c.m?.includes(me.id));

    setAttr(card, 'data-kind', c.r);
    let key = c.r ? null : c.k;
    let twoKeys = false;
    if (coop && over && !c.r && c.ks) {
      twoKeys = true;
      key = null;
      card.style.setProperty('--k1', KEY_COLORS[c.ks[sideA]]);
      card.style.setProperty('--k2', KEY_COLORS[c.ks[sideB]]);
    }
    setAttr(card, 'data-key', key);
    setAttr(card, 'data-key2', twoKeys ? '1' : null);

    card.disabled = !pickable;
    card.classList.toggle('can-pick', pickable);
    card.classList.toggle('is-tried', Boolean(tried) && !over);
    card.classList.toggle('is-pointed', Boolean(c.m?.length) && !c.r);

    setHtml(card.querySelector('.card-shape'), c.r ? icon(c.r) : key ? icon(key) : '');
    setHtml(
      card.querySelector('.card-marks'),
      c.r ? '' : (c.m ?? []).map((id) => `<i title="${esc(names.get(id) ?? '')}">${esc(initials(names.get(id) ?? '?'))}</i>`).join(''),
    );
    setHtml(card.querySelector('.card-miss'), c.r ? '' : (c.x ?? []).map((t) => `<i data-team="${t}"></i>`).join(''));

    let label = `${c.w}, ${coord(i, round.cols)}`;
    if (c.r) label += `, revealed: ${KIND_WORDS[c.r]}`;
    else if (key) label += `, ${KIND_WORDS[key]} on your key`;
    if (mine) label += ', you are pointing at this';
    setAttr(card, 'aria-label', label);

    // The Reveal button only exists on the card you are pointing at.
    let confirm = cell.querySelector('.confirm');
    if (mine && pickable) {
      if (!confirm) {
        confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.className = 'confirm';
        confirm.dataset.i = i;
        confirm.textContent = 'Reveal';
        confirm.setAttribute('aria-label', `Reveal ${c.w}`);
        cell.append(confirm);
      }
    } else if (confirm) {
      confirm.remove();
    }
  });
}
