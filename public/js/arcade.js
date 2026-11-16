// The au12 Arcade (github.com/au12/arcade), when Tradecraft is one of its games.
//
// js/vendor/arcade.js is the arcade's own script. In the arcade's frame it
// learns who is playing; opened on its own it asks the arcade named in
// /arcade.json. Without an arcade every call here quietly does nothing.

import { store } from './util.js';

const A = globalThis.Arcade ?? null;

/** Waits for the arcade to say who is playing, but not for long. */
export function arcadeReady(ms = 1500) {
  if (!A) return Promise.resolve(null);
  return Promise.race([A.ready, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
}

/** The arcade player's name, for the name box. */
export const arcadeName = () => (A?.player?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 20);

/**
 * A storage key that belongs to whoever is playing, so each person at a shared
 * arcade cabinet keeps a seat and a name of their own. The first arcade player
 * on a browser keeps the plain keys (the seat they already had there); anyone
 * else, a guest in the arcade's frame and everyone on a kiosk gets their own.
 */
export function personal(key) {
  if (!A || (A.mode !== 'embedded' && A.mode !== 'direct')) return key;
  const id = A.player?.id;
  if (!id) return A.mode === 'embedded' ? `${key}@guest` : key;
  if (A.kiosk) return `${key}@${id}`;
  let owner = store.get('arcadeOwner');
  if (!owner) store.set('arcadeOwner', (owner = id));
  return owner === id ? key : `${key}@${id}`;
}

let lastStatus = '';
/** What the game is doing: 'menu', 'playing' or 'over'. */
export function arcadeStatus(status) {
  if (!A || status === lastStatus) return;
  lastStatus = status;
  A.status(status);
}

/** The room's link, shown as a QR code on the arcade cabinet so phones can join. */
export function arcadeInvite(url) {
  A?.invite(url, url ? 'Scan to join this game' : '');
}

const reported = new Set();

/**
 * Reports a round you played in and saw end: a win if one of your teams took
 * it, otherwise a loss. Rounds called off, rounds you only watched, a page
 * opened on a round that is already over, and a seat on every team (you
 * can't lose) report nothing.
 */
export function arcadeReport(prev, next) {
  if (!A || !prev?.round || !next?.round) return;
  const a = prev.round;
  const r = next.round;
  if (r.phase !== 'over' || a.id !== r.id || a.phase === 'over' || r.reason === 'abandoned' || !r.winner) return;
  const me = next.players.find((p) => p.id === next.you);
  const mine = (me?.teams ?? []).filter((t) => r.order.includes(t));
  if (!mine.length || mine.length === r.order.length || reported.has(r.id)) return;
  reported.add(r.id);
  const players = next.players.filter((p) => p.teams?.some((t) => r.order.includes(t))).length;
  A.result(mine.includes(r.winner) ? 'win' : 'loss', {
    meta: { role: me.role, reason: r.reason, teams: r.order.length, players },
  });
}
