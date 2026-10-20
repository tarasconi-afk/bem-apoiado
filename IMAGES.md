# Imagens do site

Toda imagem publicada precisa estar aqui, com origem e licença. Fotos de anúncio da Amazon não entram
(contrato do Programa de Associados); imagem de produto só via PA-API, quando liberada.

| Arquivo / componente | O que é | Origem | Licença |
| --- | --- | --- | --- |
| `site/src/components/Logo.astro`, `site/public/favicon.svg`, `site/public/apple-touch-icon.png` | Marca ("b" que é uma cama de perfil) | Desenho próprio do projeto (2026-10-20) | Própria |
| `site/src/components/Illustration.astro` | Esquemas por tipo de produto (espuma, molas ensacadas, molas interligadas, misto, travesseiro, cadeira, genérico), gerados por código | Desenho próprio do projeto (2026-10-20) | Própria |
| `site/public/og/*.png` | Imagens de compartilhamento (1200×630): marca + esquema do tipo | Captura das ilustrações acima | Própria |

Avaliado e recusado (2026-10-20): fotos do Wikimedia Commons. As de "domínio público" com quartos claros
vinham de material de investigação (caso Epstein, governo das Ilhas Virgens); o lote "obra própria" sem
revisão de licença (Shixart1985) não tem origem verificável; as de licença confirmada (Pixabay/Pexels) não
tinham relação com o tema. Unsplash recusa acesso automatizado. Ilustração própria venceu em licença,
consistência e utilidade editorial (mostra como cada tipo é construído).

Nicho novo: acrescentar um desenho por tipo em `Illustration.astro`; tipo sem desenho cai no genérico.
