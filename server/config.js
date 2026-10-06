// All configuration comes from environment variables so the same image runs
// anywhere. Every value has a sensible default.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

const int = (name, fallback, min, max) => {
  const n = Number.parseInt(env[name] ?? '', 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};

/** "/games/tradecraft/" -> "/games/tradecraft"; "" or "/" -> "" */
const cleanBase = (value) => {
  const trimmed = String(value ?? '').trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '';
};

export const config = {
  root,
  host: env.HOST || '0.0.0.0',
  port: int('PORT', 3000, 1, 65535),
  siteName: (env.SITE_NAME || 'Tradecraft').slice(0, 40),
  basePath: cleanBase(env.BASE_PATH),
  publicDir: path.join(root, 'public'),
  builtinWordlists: path.join(root, 'wordlists'),
  // Extra word lists you drop in (mounted volume in Docker).
  customWordlists: env.WORDLISTS_DIR || path.join(root, 'data', 'wordlists'),
  dataDir: env.DATA_DIR || path.join(root, 'data'),
  persist: env.PERSIST !== 'false',
  // If set, people must enter this to create a room. Joining is never gated.
  createPassword: env.CREATE_PASSWORD || '',
  roomTtlHours: int('ROOM_TTL_HOURS', 48, 1, 24 * 90),
  maxRooms: int('MAX_ROOMS', 500, 1, 100000),
  maxPlayers: int('MAX_PLAYERS_PER_ROOM', 64, 2, 256),
  // Comma-separated list of allowed Origin headers for the WebSocket. Empty = any.
  allowedOrigins: (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean),
  logLevel: env.LOG_LEVEL || 'info',
};

export const log = {
  info: (...a) => config.logLevel !== 'silent' && console.log(new Date().toISOString(), ...a),
  warn: (...a) => config.logLevel !== 'silent' && console.warn(new Date().toISOString(), 'WARN', ...a),
  debug: (...a) => config.logLevel === 'debug' && console.log(new Date().toISOString(), 'DEBUG', ...a),
};
