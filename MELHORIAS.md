# Melhorias e auditoria

Atualizado em 2026-10-11.

## Concluído nesta revisão

- `SEC-01`: downloads Node de sitemap, CSS externo e assets agora usam `scripts/safe-http.mjs`: somente HTTP/HTTPS, DNS conferido e fixado para a conexão, redirects revalidados (máximo de cinco), prazo por requisição e limite de bytes. Endereços privados/reservados são recusados, exceto localhost, nomes locais e IPs privados informados explicitamente.
- `SEC-02`: sitemaps filhos só são buscados quando pertencem ao mesmo site; antes, qualquer `<loc>` XML podia iniciar uma requisição externa.
- `CLI-01`: `manifest.mjs status` não carrega Playwright. A ausência do manifesto agora mostra o comando para inicializar, mesmo em uma instalação sem dependências do navegador.
- `DEP-01`: Next.js e `eslint-config-next` atualizados para 16.4.0, transitive dependencies corrigidas dentro das faixas compatíveis e `shadcn` movido para dependências de desenvolvimento. CI verifica `npm audit --omit=dev`.
- `LINT-01`: removidos dois avisos existentes do ESLint com alterações de fluxo equivalentes.

## Pendências conhecidas

- A auditoria completa ainda encontra o advisory de alta severidade em `braces`, alcançado por ferramentas de desenvolvimento (`shadcn` e `eslint-config-next`). O registry sugere `npm audit fix --force`, que troca `shadcn` 4.x por 1.0.0; essa alteração incompatível não foi aplicada. A auditoria de produção (`npm audit --omit=dev`) está limpa.
- A validação de destino cobre os downloads feitos diretamente pelo Node. Navegação e sub-recursos normais do Chromium continuam seguindo o comportamento do navegador durante a extração.
