import type { APIRoute } from 'astro';
import { publicPages } from '../lib/content';

// Só páginas públicas (aprovadas); rascunho nunca entra, nem na prévia.
export const GET: APIRoute = ({ site }) => {
  const pages = publicPages().filter((p) => p.status !== 'draft');
  const urls = [
    { loc: '/', lastmod: pages.map((p) => p.updated_at).sort().at(-1) },
    { loc: '/como-trabalhamos/' },
    ...pages.map((p) => ({ loc: `/${p.slug}/`, lastmod: p.updated_at })),
  ];
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${new URL(u.loc, site)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`)
    .join('\n')}\n</urlset>\n`;
  return new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
};
