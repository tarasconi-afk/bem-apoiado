import { checkProduct } from '@bem-apoiado/core';
import { buildIndex, loadProducts } from '../packages/engine/src/store.ts';
import { loadNiche } from '../packages/engine/src/niche.ts';
const idx = buildIndex();
const n = loadNiche();
const LABEL = Object.fromEntries(n.product_kinds.map((k: {id:string;label:string}) => [k.id, k.label]));
for (const p of loadProducts()) {
  if (!['B0FXH2K15G','B0H37LXVSJ','B0CKCKMDRH','B089DY771C'].includes(p.asin)) continue;
  const v = checkProduct(p, idx, new Date(), LABEL[p.kind], n.forbidden_terms);
  console.log(p.asin, p.kind, '->', v.length ? v.map((x) => `${x.code} ${x.detail}`).join(' | ') : 'OK');
}
