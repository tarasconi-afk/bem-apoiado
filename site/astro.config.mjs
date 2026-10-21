import { defineConfig } from 'astro/config';

export default defineConfig({
  site: process.env.SITE_URL ?? 'https://bemapoiado.com.br',
  // Prévia de ramo no painel: build em subcaminho e pasta própria, sem tocar no site/dist.
  base: process.env.SITE_BASE ?? '/',
  outDir: process.env.SITE_OUT_DIR ?? './dist',
  output: 'static',
  trailingSlash: 'always',
  build: { format: 'directory' },
});
