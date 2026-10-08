@/Users/buivannin/.codex/RTK.md

# Codex Local Server

Local HTTP chat gateway to Codex CLI authenticated with ChatGPT. Node 22.13+
(prefer the version in `.nvmrc`), TypeScript ESM/NodeNext, Fastify, Zod, Ajv,
built-in SQLite, and vanilla HTML/CSS/JavaScript. No frontend bundler.

## Work from evidence

- Inspect Git state and preserve user changes. Do not print `.env`, Codex auth,
  chat transcripts, or session messages while diagnosing configuration.
- Run commands from the repository root with `rtk` as required above.
- Use `nvm use`; verify both Node and npm resolve to that runtime. The manifest
  scripts are authoritative; command and runtime details: `docs/DEVELOPMENT.md`.
- Development: `npm run dev`. Compiled foreground runtime: `npm run build`,
  then `npm start`. Keep an agent-started development process attached to a
  visible terminal. The user's explicitly requested detached mode is
  `npm start --silent -- -d`; `npm stop` stops only its managed background PID.

## Architecture and invariants

- `src/server.ts` orchestrates HTTP, auth, limits, cancellation and sessions.
  `src/schema.ts` and `src/protocol.ts` define request/response/tool contracts.
- `src/provider.ts` invokes the CLI directly with an environment whitelist.
  Preserve ChatGPT auth, read-only sandbox, disabled agent tools/network,
  and rejection of unexpected tool execution. Function calls are proposals
  executed by the caller, never commands executed by this gateway.
- Bind remains `127.0.0.1`; preserve Host/Origin/Bearer checks. Do not broaden
  trusted hosts, CORS, binds or provider capabilities to make a proxy work.
- `sessions.json` stores conversation messages; SQLite stores metadata and
  usage only. Preserve this privacy boundary and playground ephemerality.
- Native usage reads Codex state/rollouts only. Never mutate the source DB,
  auth/config or transcripts. Keep gateway and native usage totals separate.
- Preserve stable event IDs, deduplication, cumulative delta handling and
  price snapshots. Unknown usage/pricing remains unknown, never free/zero.
- One server process per `DATA_DIR`; session JSON has no cross-process lock.
  Do not reset real `.local` data for verification; use isolated test fixtures.
- Dashboard assets are loaded at startup in `src/dashboard.ts`; restart is
  needed for edited assets. Use Vietnamese UI text and an accessible favicon.

## Load knowledge when needed

- API, sessions, cost formulas, native ranges/spikes: relevant sections of
  `README.md`; catalog provenance and pricing limitations: `data/README.md`.
- Video builds/import/export: the Video builds section of `README.md`;
  `src/video-builds.ts` is the dashboard schema authority. Validate external
  manifests against it; a skill template is not proof of import compatibility.
- Provider, storage, security and file map: `docs/TECHNICAL.md`.
  Its human-readable visual companion is `docs/architecture.html`.
- Setup, process management, Node mismatch, ports/proxy and bootstrap findings:
  `docs/DEVELOPMENT.md` (`docs/DEVELOPMENT.html` for humans).
- Reuse available global `feature-builder` for bounded product features,
  `task-qa-review` for requested task review, and `security-review` for security
  audits. Keep project facts here/in docs rather than copying those methods.

## Validate and deliver

- Use `npm run check` and `npm run build` for TypeScript changes; relevant
  `npm test` suites for behavioral changes. Inspect rendered UI for UI changes.
- `npm run test:live` calls the real account and consumes usage; run only when
  authorized. Report checks actually performed and any verification limits.
- Update canonical Markdown first, then its affected HTML companion. Follow
  existing architecture and retain permission/data invariants.
- Before any host port decision, inspect the central Dev Hub registry at
  `/Users/buivannin/Desktop/workspace/personal/dev-hub/projects.yml`.
  This repo has no registered block as of the bootstrap; current API port is
  15600 with registered block 15600–15699 and hostname codex-server.localhost.
  Verify the route before claiming it works.
