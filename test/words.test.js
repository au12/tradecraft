import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanWord, parsePack, uniqueWords, wordKey } from '../server/words.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'wordlists');

test('accented words are kept as written but match their plain spelling', () => {
  const decomposed = 'piñata'; // what some keyboards and copy-paste produce
  assert.equal(cleanWord(decomposed), 'piñata');
  assert.equal(wordKey('piñata'), 'PINATA');
  assert.deepEqual(uniqueWords(['piñata', 'PINATA', decomposed, 'Piñata']), ['piñata']);
});

test('every built-in pack parses, and no word appears in more than one pack', () => {
  const seen = new Map();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.txt'))) {
    const pack = parsePack(fs.readFileSync(path.join(dir, file), 'utf8'), file);
    assert.ok(pack.name && pack.description, `${file} has a name and description`);
    assert.ok(pack.words.length >= 50, `${file} has a useful number of words`);
    for (const word of pack.words) {
      const key = wordKey(word);
      assert.ok(!seen.has(key), `"${word}" is in both ${seen.get(key)} and ${file}`);
      seen.set(key, file);
    }
  }
  assert.ok(seen.size > 1000);
});
