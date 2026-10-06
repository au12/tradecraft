// Word packs are plain text files.
//
//   Line 1            the pack's display name
//   Lines with "# k: v"  optional metadata (description, language)
//   Every other line  one word or short phrase
//
// This is the same layout the original Clonenames used (title on the first
// line, then one word per line), so existing lists drop straight in.

import fs from 'node:fs';
import path from 'node:path';
import { config, log } from './config.js';

const MAX_WORD = 28;

export function cleanWord(raw) {
  return String(raw)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_WORD);
}

/** Case-insensitive de-duplication that keeps the first spelling seen. */
export function uniqueWords(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const word = cleanWord(raw);
    if (!word) continue;
    const key = word.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(word);
  }
  return out;
}

export function parsePack(text, id) {
  const lines = text.split(/\r?\n/);
  const meta = {};
  let name = null;
  const words = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = /^#\s*([a-z]+)\s*:\s*(.+)$/i.exec(trimmed);
    if (m) {
      meta[m[1].toLowerCase()] = m[2].trim();
      continue;
    }
    if (trimmed.startsWith('#')) continue;
    if (name === null) {
      name = trimmed.slice(0, 60);
      continue;
    }
    words.push(trimmed);
  }
  return {
    id,
    name: name ?? id,
    description: meta.description ?? '',
    language: meta.language ?? '',
    words: uniqueWords(words),
  };
}

function readDir(dir, source) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const packs = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    if (/\.(md|json|ya?ml)$/i.test(entry.name)) continue;
    const id = `${source === 'custom' ? 'x-' : ''}${entry.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    try {
      const pack = parsePack(fs.readFileSync(path.join(dir, entry.name), 'utf8'), id);
      if (pack.words.length === 0) continue;
      packs.push({ ...pack, source });
    } catch (err) {
      log.warn(`Could not read word list ${entry.name}: ${err.message}`);
    }
  }
  return packs;
}

let packs = new Map();

export function loadPacks() {
  const all = [...readDir(config.builtinWordlists, 'builtin'), ...readDir(config.customWordlists, 'custom')];
  // Keep "everyday" first: it is the default pack.
  all.sort((a, b) => (b.id === 'everyday') - (a.id === 'everyday'));
  packs = new Map(all.map((p) => [p.id, p]));
  log.info(`Loaded ${packs.size} word packs (${all.reduce((n, p) => n + p.words.length, 0)} words)`);
  return packs;
}

export function listPacks() {
  return [...packs.values()].map(({ id, name, description, language, source, words }) => ({
    id,
    name,
    description,
    language,
    source,
    count: words.length,
  }));
}

export function getPack(id) {
  return packs.get(id);
}

export function defaultPackId() {
  return packs.has('everyday') ? 'everyday' : packs.keys().next().value;
}

/** Every word a room may draw from, given its settings. */
export function wordPool(settings) {
  const custom = uniqueWords(settings.customWords ?? []);
  const fromPacks = settings.customOnly && custom.length ? [] : (settings.packs ?? []).flatMap((id) => getPack(id)?.words ?? []);
  return uniqueWords([...custom, ...fromPacks]);
}
