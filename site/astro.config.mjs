import { defineConfig } from 'astro/config';

export default defineConfig({
  site: process.env.SITE_URL ?? 'https://bemapoiado.com.br',
  output: 'static',
  trailingSlash: 'always',
  build: { format: 'directory' },
});
