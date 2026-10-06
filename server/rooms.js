// Rooms, players, seats, host controls, timers and persistence.
// The rules themselves live in game.js; this file decides *who* may do *what*
// and what each person is allowed to see.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';
import * as game from './game.js';
import { config, log } from './config.js';
import { roomCode } from './names.js';
import { cleanWord, defaultPackId, getPack, uniqueWords, wordPool } from './words.js';

const TEAM_NAMES = { red: 'Red', blue: 'Blue', green: 'Green', yellow: 'Yellow' };
const SEAT_TAKEOVER_MS = 30_000; // an offline spymaster's seat can be claimed after this
const HOST_HANDOVER_MS = 45_000; // an offline host is replaced after this
const MAX_CUSTOM_WORDS = 2000;

const now = () => Date.now();
const newId = () => randomBytes(6).toString('base64url');

export function cleanName(raw) {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
}

function defaultSettings() {
  return {
    mode: 'classic',
    teamCount: 2,
    cols: 5,
    assassins: 1,
    coopTurns: 9,
    packs: [defaultPackId()].filter(Boolean),
    customWords: [],
    customOnly: false,
    clueSeconds: 0,
    guessSeconds: 0,
    strictClues: true,
  };
}

const live = (room) => Boolean(room.round && room.round.phase !== 'over');

export function activeTeamIds(room) {
  return game.TEAM_IDS.slice(0, room.settings.mode === 'coop' ? 2 : room.settings.teamCount);
}

function cardsNeeded(settings) {
  return settings.mode === 'coop' ? game.COOP_COLS ** 2 : settings.cols ** 2;
}

export class Rooms {
  constructor() {
    this.rooms = new Map();
    this.saveTimer = null;
    this.file = path.join(config.dataDir, 'rooms.json');
  }

  // ───────────────────────── lifecycle ─────────────────────────

  create() {
    if (this.rooms.size >= config.maxRooms) this.sweep(true);
    if (this.rooms.size >= config.maxRooms) return null;
    let code = roomCode();
    while (this.rooms.has(code)) code = roomCode();
    const room = {
      code,
      createdAt: now(),
      lastActive: now(),
      hostId: null,
      locked: false,
      settings: defaultSettings(),
      teams: game.TEAM_IDS.map((id) => ({ id, name: TEAM_NAMES[id], wins: 0 })),
      coop: { wins: 0, losses: 0 },
      players: new Map(),
      banned: [],
      round: null,
      roundNo: 0,
      used: [],
      lastStarter: null,
    };
    room.poolSize = wordPool(room.settings).length;
    this.rooms.set(code, room);
    this.touch(room);
    return room;
  }

  get(code) {
    return this.rooms.get(code);
  }

  touch(room) {
    room.lastActive = now();
    this.scheduleSave();
  }

  /** Drop rooms nobody has used for a while. */
  sweep(aggressive = false) {
    const ttl = config.roomTtlHours * 3600_000;
    for (const room of this.rooms.values()) {
      const online = [...room.players.values()].some((p) => p.online);
      const idle = now() - room.lastActive;
      if (!online && (idle > ttl || (aggressive && idle > 3600_000))) {
        clearTimeout(room.timer);
        this.rooms.delete(room.code);
        log.debug(`Removed idle room ${room.code}`);
        continue;
      }
      // Forget long-gone spectators so the player list stays tidy.
      for (const p of room.players.values()) {
        if (!p.online && p.id !== room.hostId && now() - p.seenAt > (p.team ? 6 : 1) * 3600_000) room.players.delete(p.id);
      }
    }
    this.scheduleSave();
  }

  // ───────────────────────── connections ─────────────────────────

  /** Returns { player } or { error, code }. */
  connect(room, { token, name }, socket) {
    if (room.banned.includes(token)) return { code: 'banned', error: 'The host removed you from this room.' };
    let player = [...room.players.values()].find((p) => p.token === token);
    if (!player) {
      const nick = cleanName(name);
      if (!nick) return { code: 'name', error: 'Pick a name to join.' };
      if (room.locked) return { code: 'locked', error: 'This room is locked. Ask the host to unlock it.' };
      if (room.players.size >= config.maxPlayers) return { code: 'full', error: 'This room is full.' };
      player = {
        id: newId(),
        token,
        name: this.freeName(room, nick),
        team: null,
        role: 'spectator',
        online: false,
        sockets: new Set(),
        joinedAt: now(),
        seenAt: now(),
        sawKey: null,
        spyRounds: 0,
      };
      room.players.set(player.id, player);
    } else if (name && cleanName(name) && cleanName(name) !== player.name) {
      player.name = this.freeName(room, cleanName(name), player.id);
    }
    player.sockets.add(socket);
    player.online = true;
    player.seenAt = now();
    this.ensureHost(room);
    // Timers stop while a room is empty and pick up when someone returns.
    const r = room.round;
    if (r && r.autoPaused && r.pausedLeft != null) {
      r.deadline = now() + r.pausedLeft;
      r.pausedLeft = null;
      r.autoPaused = false;
    }
    this.syncTimer(room);
    this.touch(room);
    return { player };
  }

  disconnect(room, player, socket) {
    player.sockets.delete(socket);
    if (player.sockets.size > 0) return;
    player.online = false;
    player.seenAt = now();
    if (room.round) game.removeMarksOf(room.round, player.id);
    const anyone = [...room.players.values()].some((p) => p.online);
    const r = room.round;
    if (!anyone && r && r.deadline) {
      r.pausedLeft = Math.max(1000, r.deadline - now());
      r.deadline = null;
      r.autoPaused = true;
      this.syncTimer(room);
    }
    if (player.id === room.hostId && anyone) {
      setTimeout(() => {
        if (this.ensureHost(room)) this.broadcast(room);
      }, HOST_HANDOVER_MS + 500).unref?.();
    }
    this.touch(room);
    this.broadcast(room);
  }

  /** Makes sure the room has a reachable host. Returns true if it changed. */
  ensureHost(room) {
    const host = room.players.get(room.hostId);
    if (host && (host.online || now() - host.seenAt < HOST_HANDOVER_MS)) return false;
    const next = [...room.players.values()].filter((p) => p.online).sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (!next || next.id === room.hostId) return false;
    room.hostId = next.id;
    return true;
  }

  freeName(room, name, exceptId) {
    const taken = new Set([...room.players.values()].filter((p) => p.id !== exceptId).map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; n < 100; n++) {
      const candidate = `${name.slice(0, 17)} ${n}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return `${name.slice(0, 14)} ${randomInt(1000)}`;
  }

  // ───────────────────────── views ─────────────────────────

  viewFor(room, me) {
    const active = activeTeamIds(room);
    const r = room.round;
    const isHost = me.id === room.hostId;
    let round = null;
    if (r) {
      const over = r.phase === 'over';
      const onBoard = r.order.includes(me.team);
      const seesClassicKey = r.mode === 'classic' && (over || (me.role === 'spymaster' && onBoard));
      const cards = r.cards.map((c, i) => {
        const v = { w: c.word, r: null };
        if (r.mode === 'classic') {
          if (c.revealed) {
            v.r = c.owner;
            v.by = c.by;
          }
          if (seesClassicKey) v.k = c.owner;
        } else {
          if (c.revealed) {
            v.r = c.result;
            v.by = c.by;
          }
          if (c.miss.length) v.x = c.miss;
          if (over) v.ks = c.keys;
          else if (onBoard) v.k = c.keys[me.team];
        }
        if (r.marks[i]) v.m = r.marks[i];
        return v;
      });
      round = {
        id: r.id,
        mode: r.mode,
        cols: r.cols,
        rows: r.rows,
        order: r.order,
        phase: r.phase,
        turn: game.currentTeam(r),
        guessing: game.guessingTeams(r),
        clue: r.clue,
        guessesLeft: r.guessesLeft,
        guessesMade: r.guessesMade,
        winner: r.winner,
        outcome: r.outcome,
        reason: r.reason,
        loser: r.loser ?? null,
        remaining: r.remaining,
        eliminated: r.eliminated,
        tokens: r.tokens,
        turnsTotal: r.turnsTotal,
        sudden: r.sudden,
        agentsLeft: r.agentsLeft,
        deadline: r.deadline,
        pausedLeft: r.pausedLeft,
        cards,
        log: r.log,
      };
    }
    const s = room.settings;
    return {
      code: room.code,
      now: now(),
      you: me.id,
      hostId: room.hostId,
      locked: room.locked,
      roundNo: room.roundNo,
      settings: {
        ...s,
        customWords: isHost ? s.customWords : undefined,
        customCount: s.customWords.length,
      },
      poolSize: room.poolSize,
      cardsNeeded: cardsNeeded(s),
      teams: room.teams.filter((t) => active.includes(t.id)),
      coop: room.coop,
      players: [...room.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        team: active.includes(p.team) ? p.team : null,
        role: active.includes(p.team) ? p.role : 'spectator',
        online: p.online,
      })),
      round,
    };
  }

  broadcast(room) {
    for (const player of room.players.values()) {
      if (player.sockets.size === 0) continue;
      const payload = JSON.stringify({ t: 'state', s: this.viewFor(room, player) });
      for (const socket of player.sockets) {
        if (socket.readyState === 1) socket.send(payload);
      }
    }
  }

  // ───────────────────────── timers ─────────────────────────

  syncTimer(room) {
    clearTimeout(room.timer);
    room.timer = null;
    const r = room.round;
    if (!r || r.phase === 'over') return;
    const key = `${r.phase}:${r.turn}:${r.clueNo}:${r.tokens ?? ''}`;
    if (r.timerKey !== key) {
      r.timerKey = key;
      const s = room.settings;
      const secs = r.mode === 'coop' && r.sudden ? 0 : r.phase === 'clue' ? s.clueSeconds : s.guessSeconds;
      r.pausedLeft = null;
      r.autoPaused = false;
      r.deadline = secs > 0 ? now() + secs * 1000 : null;
    }
    if (r.deadline) {
      room.timer = setTimeout(() => this.onTimeout(room), Math.max(0, r.deadline - now()) + 30);
      room.timer.unref?.();
    }
  }

  onTimeout(room) {
    const r = room.round;
    if (!r || !r.deadline || r.deadline - now() > 250) return;
    if (!game.timeout(r).ok) return;
    this.afterChange(room);
    this.broadcast(room);
  }

  /** Bookkeeping after anything that may have advanced the round. */
  afterChange(room) {
    const r = room.round;
    if (r && r.phase === 'over' && !r.scored) {
      r.scored = true;
      if (r.reason !== 'abandoned') {
        if (r.mode === 'classic' && r.winner) room.teams.find((t) => t.id === r.winner).wins += 1;
        if (r.mode === 'coop') room.coop[r.outcome === 'win' ? 'wins' : 'losses'] += 1;
      }
    }
    this.syncTimer(room);
    this.touch(room);
  }

  // ───────────────────────── seats ─────────────────────────

  seat(room, player, team, role, { force = false } = {}) {
    const r = room.round;
    if (team === null) {
      player.team = null;
      player.role = 'spectator';
      if (r) game.removeMarksOf(r, player.id);
      return null;
    }
    if (!activeTeamIds(room).includes(team)) return 'That team is not in this game.';
    const coop = room.settings.mode === 'coop';
    const wanted = coop ? 'operative' : role === 'spymaster' ? 'spymaster' : 'operative';
    if (player.team === team && player.role === wanted) return null;

    if (live(room) && !force) {
      if (coop && player.sawKey && player.sawKey !== `${r.id}:${team}`) {
        return 'You have seen the other side’s key this round. You can switch sides next round.';
      }
      if (!coop && wanted === 'operative' && player.sawKey === r.id) {
        return 'You have seen the key this round, so you can’t guess. You can switch next round.';
      }
    }
    if (wanted === 'spymaster') {
      const holder = [...room.players.values()].find((p) => p.team === team && p.role === 'spymaster' && p.id !== player.id);
      if (holder) {
        const gone = !holder.online && now() - holder.seenAt > SEAT_TAKEOVER_MS;
        if (!force && !gone) return `${holder.name} is already the spymaster.`;
        if (force && !live(room)) {
          holder.role = 'operative';
        } else {
          // Mid-round they already know the key, so they sit the rest out.
          holder.team = null;
          holder.role = 'spectator';
        }
      }
    }
    if (r) game.removeMarksOf(r, player.id);
    player.team = team;
    player.role = wanted;
    if (live(room)) {
      if (coop) player.sawKey = `${r.id}:${team}`;
      else if (wanted === 'spymaster') player.sawKey = r.id;
    }
    return null;
  }

  dealTeams(room) {
    const teams = activeTeamIds(room);
    const coop = room.settings.mode === 'coop';
    // People who have been spymaster least go first, so the job rotates.
    const pool = game
      .shuffle([...room.players.values()].filter((p) => p.online))
      .sort((a, b) => a.spyRounds - b.spyRounds);
    if (pool.length < teams.length) return 'Not enough players online to fill the teams.';
    const offset = randomInt(teams.length);
    for (const p of room.players.values()) {
      p.team = null;
      p.role = 'spectator';
    }
    pool.forEach((p, i) => {
      p.team = teams[(i + offset) % teams.length];
      p.role = !coop && i < teams.length ? 'spymaster' : 'operative';
    });
    return null;
  }

  startRound(room, { shuffle = false, force = false } = {}) {
    if (live(room) && !force) return 'A round is still in progress.';
    if (shuffle) {
      const err = this.dealTeams(room);
      if (err) return err;
    }
    const s = room.settings;
    const teams = activeTeamIds(room);
    const members = (team, role) => [...room.players.values()].filter((p) => p.team === team && (!role || p.role === role));
    for (const team of teams) {
      const name = room.teams.find((t) => t.id === team).name;
      if (s.mode === 'coop') {
        if (members(team).length === 0) return `${name} needs at least one player.`;
      } else {
        if (members(team, 'spymaster').length === 0) return `${name} needs a spymaster.`;
        if (members(team, 'operative').length === 0) return `${name} needs at least one operative.`;
      }
    }

    const need = cardsNeeded(s);
    const pool = wordPool(s);
    if (pool.length < need) {
      return `This board needs ${need} words but the selected packs only have ${pool.length}. Add a pack or pick a smaller board.`;
    }
    // Avoid repeating words from earlier rounds until the pool runs dry.
    const used = new Set(room.used);
    let fresh = pool.filter((w) => !used.has(w.toUpperCase()));
    if (fresh.length < need) {
      room.used = [];
      fresh = pool;
    }
    const words = game.shuffle(fresh).slice(0, need);
    room.used.push(...words.map((w) => w.toUpperCase()));

    // The starting team rotates from round to round.
    const last = teams.indexOf(room.lastStarter);
    const firstTeam = last === -1 ? teams[randomInt(teams.length)] : teams[(last + 1) % teams.length];
    room.lastStarter = firstTeam;

    room.round =
      s.mode === 'coop'
        ? game.createCoopRound({ teams, words, turns: s.coopTurns, firstTeam })
        : game.createClassicRound({ teams, cols: s.cols, words, assassins: s.assassins, firstTeam });
    room.roundNo += 1;

    for (const p of room.players.values()) {
      p.sawKey = null;
      if (!teams.includes(p.team)) continue;
      if (s.mode === 'coop') p.sawKey = `${room.round.id}:${p.team}`;
      else if (p.role === 'spymaster') {
        p.sawKey = room.round.id;
        p.spyRounds += 1;
      }
    }
    return null;
  }

  // ───────────────────────── settings ─────────────────────────

  applySettings(room, patch) {
    if (!patch || typeof patch !== 'object') return 'Nothing to change.';
    const s = room.settings;
    const next = { ...s };
    const intIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

    if ('mode' in patch) {
      if (!['classic', 'coop'].includes(patch.mode)) return 'Unknown mode.';
      next.mode = patch.mode;
    }
    if ('teamCount' in patch) {
      if (!intIn(patch.teamCount, 2, 4)) return 'Pick 2 to 4 teams.';
      next.teamCount = patch.teamCount;
    }
    if ('cols' in patch) {
      if (!intIn(patch.cols, 4, 10)) return 'Board size must be between 4×4 and 10×10.';
      next.cols = patch.cols;
    }
    if ('assassins' in patch) {
      if (!intIn(patch.assassins, 0, 3)) return 'Pick 0 to 3 assassins.';
      next.assassins = patch.assassins;
    }
    if ('coopTurns' in patch) {
      if (!intIn(patch.coopTurns, 5, 12)) return 'Pick 5 to 12 turns.';
      next.coopTurns = patch.coopTurns;
    }
    for (const key of ['clueSeconds', 'guessSeconds']) {
      if (key in patch) {
        if (!(patch[key] === 0 || intIn(patch[key], 15, 900))) return 'Timers run from 15 seconds to 15 minutes, or off.';
        next[key] = patch[key];
      }
    }
    if ('strictClues' in patch) next.strictClues = Boolean(patch.strictClues);
    if ('customOnly' in patch) next.customOnly = Boolean(patch.customOnly);
    if ('packs' in patch) {
      if (!Array.isArray(patch.packs)) return 'Bad pack list.';
      next.packs = [...new Set(patch.packs.filter((id) => typeof id === 'string' && getPack(id)))];
    }
    if ('customWords' in patch) {
      const raw = Array.isArray(patch.customWords) ? patch.customWords : String(patch.customWords ?? '').split(/[\n,;]+/);
      next.customWords = uniqueWords(raw.slice(0, MAX_CUSTOM_WORDS * 2).map(cleanWord)).slice(0, MAX_CUSTOM_WORDS);
    }
    const structural = ['mode', 'teamCount', 'cols', 'assassins', 'coopTurns'].some((k) => next[k] !== s[k]);
    if (structural && live(room)) return 'End the current round before changing the mode, teams or board.';

    const timersChanged = next.clueSeconds !== s.clueSeconds || next.guessSeconds !== s.guessSeconds;
    room.settings = next;
    room.poolSize = wordPool(next).length;

    if (structural) {
      // Leave the finished board behind and return to the lobby.
      room.round = null;
      const active = activeTeamIds(room);
      for (const p of room.players.values()) {
        if (!active.includes(p.team)) {
          p.team = null;
          p.role = 'spectator';
        } else if (next.mode !== s.mode) {
          p.role = 'operative';
        }
      }
    }
    if (timersChanged && room.round) room.round.timerKey = null;
    return null;
  }

  // ───────────────────────── actions ─────────────────────────

  /** Handles one message from a player. Returns an error string or null. */
  act(room, me, msg) {
    const isHost = me.id === room.hostId;
    const hostOnly = () => (isHost ? null : 'Only the host can do that.');
    const r = room.round;
    const target = () => room.players.get(String(msg.id ?? ''));
    let err = null;

    switch (msg.a) {
      case 'rename': {
        const name = cleanName(msg.name);
        if (!name) return 'Names need at least one character.';
        me.name = this.freeName(room, name, me.id);
        break;
      }
      case 'join':
        err = this.seat(room, me, String(msg.team), msg.role);
        break;
      case 'spectate':
        err = this.seat(room, me, null);
        break;

      case 'clue': {
        if (!r) return 'The game has not started.';
        const coop = r.mode === 'coop';
        if (!coop && me.role !== 'spymaster') return 'Only the spymaster gives clues.';
        const res = game.giveClue(r, me.team, { word: msg.word, count: msg.count }, me.name, {
          strict: room.settings.strictClues,
        });
        if (!res.ok) return res.error;
        break;
      }
      case 'mark':
      case 'guess': {
        if (!r) return 'The game has not started.';
        if (r.mode === 'classic' && me.role !== 'operative') return 'Spymasters don’t guess.';
        const index = Number(msg.i);
        if (!Number.isInteger(index)) return 'No such card.';
        const res = msg.a === 'mark' ? game.toggleMark(r, me.team, index, me.id) : game.guess(r, me.team, index, me.name);
        if (!res.ok) return res.error;
        break;
      }
      case 'endGuess': {
        if (!r) return 'The game has not started.';
        if (r.mode === 'classic' && me.role !== 'operative') return 'Only operatives can end the guessing.';
        const res = game.endGuessing(r, me.team, me.name);
        if (!res.ok) return res.error;
        break;
      }

      // ── host controls ──
      case 'start':
        err = hostOnly() ?? this.startRound(room, { shuffle: Boolean(msg.shuffle), force: Boolean(msg.force) });
        break;
      case 'shuffle':
        err = hostOnly() ?? (live(room) ? 'Finish the round before shuffling teams.' : this.dealTeams(room));
        break;
      case 'endRound':
        err = hostOnly();
        if (!err && r) game.abandon(r);
        break;
      case 'lobby':
        err = hostOnly();
        if (!err) {
          if (live(room)) game.abandon(r);
          this.afterChange(room);
          room.round = null;
        }
        break;
      case 'settings':
        err = hostOnly() ?? this.applySettings(room, msg.patch);
        break;
      case 'teamName': {
        err = hostOnly();
        const team = room.teams.find((t) => t.id === msg.team);
        const name = cleanName(msg.name).slice(0, 14);
        if (!err && team && name) team.name = name;
        break;
      }
      case 'resetScores':
        err = hostOnly();
        if (!err) {
          room.teams.forEach((t) => (t.wins = 0));
          room.coop = { wins: 0, losses: 0 };
        }
        break;
      case 'lock':
        err = hostOnly();
        if (!err) room.locked = Boolean(msg.on);
        break;
      case 'move': {
        err = hostOnly();
        const p = target();
        if (!err && !p) err = 'That player has left.';
        if (!err) err = this.seat(room, p, msg.team == null ? null : String(msg.team), msg.role, { force: true });
        break;
      }
      case 'giveHost': {
        err = hostOnly();
        const p = target();
        if (!err && !p) err = 'That player has left.';
        if (!err) room.hostId = p.id;
        break;
      }
      case 'kick': {
        err = hostOnly();
        const p = target();
        if (!err && (!p || p.id === me.id)) err = 'You can’t remove that player.';
        if (!err) {
          room.banned.push(p.token);
          if (r) game.removeMarksOf(r, p.id);
          room.players.delete(p.id);
          for (const socket of p.sockets) {
            try {
              socket.send(JSON.stringify({ t: 'kicked' }));
              socket.close(4001, 'kicked');
            } catch {}
          }
        }
        break;
      }
      case 'pause': {
        err = hostOnly();
        if (!err && r && r.phase !== 'over') {
          if (msg.on && r.deadline) {
            r.pausedLeft = Math.max(0, r.deadline - now());
            r.deadline = null;
            r.autoPaused = false;
          } else if (!msg.on && r.pausedLeft != null) {
            r.deadline = now() + r.pausedLeft;
            r.pausedLeft = null;
          }
        }
        break;
      }
      case 'addTime': {
        err = hostOnly();
        const secs = Number(msg.secs);
        if (!err && r && Number.isFinite(secs) && Math.abs(secs) <= 600) {
          if (r.deadline) r.deadline = Math.max(now() + 1000, r.deadline + secs * 1000);
          else if (r.pausedLeft != null) r.pausedLeft = Math.max(1000, r.pausedLeft + secs * 1000);
        }
        break;
      }
      default:
        return 'Unknown action.';
    }

    if (err) return err;
    this.afterChange(room);
    this.broadcast(room);
    return null;
  }

  // ───────────────────────── persistence ─────────────────────────

  scheduleSave() {
    if (!config.persist || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 1500);
    this.saveTimer.unref?.();
  }

  serialize() {
    return [...this.rooms.values()].map((room) => {
      const { players, timer, ...rest } = room;
      return {
        ...rest,
        players: [...players.values()].map(({ sockets, ...p }) => ({ ...p, online: false })),
      };
    });
  }

  save() {
    if (!config.persist) return;
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: now(), rooms: this.serialize() }));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      log.warn(`Could not save rooms: ${err.message}`);
    }
  }

  load() {
    if (!config.persist) return;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return;
    }
    const ttl = config.roomTtlHours * 3600_000;
    for (const saved of data.rooms ?? []) {
      if (now() - saved.lastActive > ttl) continue;
      const room = {
        ...saved,
        settings: { ...defaultSettings(), ...saved.settings },
        players: new Map(saved.players.map((p) => [p.id, { ...p, online: false, sockets: new Set() }])),
      };
      room.settings.packs = room.settings.packs.filter((id) => getPack(id));
      room.poolSize = wordPool(room.settings).length;
      const r = room.round;
      if (r && r.deadline) {
        // The clock does not run while the server is down.
        r.pausedLeft = Math.max(1000, r.deadline - (data.savedAt ?? now()));
        r.deadline = null;
        r.autoPaused = true;
      }
      this.rooms.set(room.code, room);
    }
    log.info(`Restored ${this.rooms.size} rooms from disk`);
  }
}
