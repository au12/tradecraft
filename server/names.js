// Friendly, easy-to-say room codes: "brass-otter-42".

import { randomInt } from 'node:crypto';

const ADJECTIVES = `amber ashen bold brass brisk calm cedar civil clever cobalt copper coral crisp dapper dusky eager early ember fabled fleet frosty gentle gilded glassy golden hardy hazel hidden humble indigo ivory jolly keen kindly lively lucky lunar marble mellow merry mighty misty noble nimble olive patient plucky polar proud quiet rapid rustic sandy scarlet shady silent silver sly snowy solar steady stormy sunny swift tidal velvet vivid wary witty zesty`.split(/\s+/);

const NOUNS = `anvil badger beacon bishop bramble canyon cipher comet condor courier dagger dynamo ember falcon ferret fjord gadget garnet glacier harbor heron jackal juniper kestrel lantern ledger magpie marten meadow mirage nettle nomad oracle osprey otter parcel pebble pigeon quarry quill raven riddle rocket sable saffron satchel signal sparrow sphinx summit tangent thistle timber tundra valley violet walnut warden willow zephyr`.split(/\s+/);

export function roomCode() {
  const pick = (list) => list[randomInt(list.length)];
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${String(randomInt(100)).padStart(2, '0')}`;
}

export function normalizeCode(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}
