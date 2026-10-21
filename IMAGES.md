# Imagens do site

Toda imagem publicada precisa estar aqui, com origem e licença. Fotos de anúncio da Amazon não entram
(contrato do Programa de Associados); imagem de produto só via PA-API, quando liberada.

| Arquivo | O que é | Origem | Licença |
| --- | --- | --- | --- |
| `site/src/assets/generated/*.webp` | Capa e uma imagem por tipo de produto (espuma, molas ensacadas, molas interligadas, misto, travesseiro, cadeira, genérica) | Geradas por IA para o projeto: `gpt-image-2` (qualidade média) via Hostinger AI Router, em 2026-10-21. Prompt, custo e sha256 de cada uma em `data/images/registry.json`; pedidos em `data/images/briefs.json` | Própria (gerada para o projeto). Sinalizada no site como "imagem ilustrativa gerada por IA" |
| `site/public/og/*.jpg` | Imagens de compartilhamento 1200×630 (marca + imagem do tipo) | Composição das imagens acima | Própria |
| `site/src/components/Logo.astro`, `site/public/favicon.svg`, `site/public/apple-touch-icon.png` | Marca ("b" que é uma cama de perfil) | Desenho próprio do projeto (2026-10-20) | Própria |
| `site/src/components/Illustration.astro` | Esquemas em SVG por tipo, gerados por código | Desenho próprio do projeto (2026-10-20) | Própria. Só aparece como reserva quando o tipo não tem imagem registrada |

Regras dos pedidos de imagem (estilo fixo em `packages/engine/src/images.ts`): sem pessoas, sem texto, sem
marca, sem logotipo, sem embalagem. A imagem mostra o tipo genérico, nunca um produto à venda.
Gerar as que faltam: `npm run engine -- images` (na VPS, onde está a chave; ~5 créditos cada).

Avaliado e recusado (2026-10-20): fotos do Wikimedia Commons. As de "domínio público" com quartos claros
vinham de material de investigação (caso Epstein, governo das Ilhas Virgens); o lote "obra própria" sem
revisão de licença (Shixart1985) não tem origem verificável; as de licença confirmada (Pixabay/Pexels) não
tinham relação com o tema. Unsplash recusa acesso automatizado. As ilustrações em SVG foram recusadas pelo
dono ("parecem desenhos mal feitos"); viraram só reserva.
