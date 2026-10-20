import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NicheProfile } from '@bem-apoiado/core';
import { DATA } from './store.ts';

let cached: NicheProfile | null = null;
export function loadNiche(): NicheProfile {
  cached ??= NicheProfile.parse(JSON.parse(readFileSync(join(DATA, 'niche.json'), 'utf8')));
  return cached;
}
