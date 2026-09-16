# CLAUDE.md — Project Memory

> This file is read at the start of every session. Keep it lean. Remove stale entries.
> Target: under 80 lines. Anything longer belongs in docs/.

---

## Project

**Name**: [project name]
**Purpose**: [one sentence — what this does and why]
**Status**: [active / maintenance / MVP / in-progress]

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | [e.g. React + TypeScript + Vite] |
| Backend | [e.g. Node.js + Express] |
| Database | [e.g. Supabase / PostgreSQL] |
| Hosting | [e.g. Vercel] |
| Auth | [e.g. Supabase Auth / JWT] |

---

## Commands

```bash
# Dev
npm run dev

# Build
npm run build

# Test
npm run test

# Lint
npm run lint

# Deploy
[deploy command]
```

---

## Architecture Rules

- [e.g. All API calls go through /lib/api.ts — never call fetch directly in components]
- [e.g. State managed via Zustand — no prop drilling beyond 2 levels]
- [e.g. Auth guard wraps all protected routes in /components/AuthGuard.tsx]

---

## Naming & Style

- [e.g. Files: kebab-case. Components: PascalCase. Functions: camelCase.]
- [e.g. CSS: Tailwind utility classes only, no custom CSS unless absolutely necessary]
- [e.g. Commits: conventional commits — feat/fix/chore/docs]

---

## Do Not Repeat (read before every task)

- [ ] Never store secrets in code — use .env + Supabase vault
- [ ] Always validate inputs server-side, not just client-side
- [ ] Run lint before every commit
- [ ] [Add project-specific rules here]

---

## Key Files

| File | Purpose |
|---|---|
| `src/lib/api.ts` | Central API layer |
| `src/store/` | Global state |
| `src/components/AuthGuard.tsx` | Auth protection |
| [add key files] | [purpose] |

---

*Last updated: [date] by Claude after [task name]*
