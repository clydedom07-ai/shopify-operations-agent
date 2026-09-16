# Context Map

> Compact reference for navigating the codebase without reading every file.
> Update when adding modules or changing architecture.

---

## Module Overview

| Module | Path | Owns | Key Interface |
|---|---|---|---|
| Auth | `src/auth/` | Login, JWT, session | `auth/service.ts → login(), refresh()` |
| API Layer | `src/lib/api.ts` | All HTTP calls | `api.get(), api.post()` |
| State | `src/store/` | Global app state | `useAuthStore, useAppStore` |
| [Module] | `path/` | [what it owns] | [entry point] |

---

## Where to Edit Common Concerns

| Concern | File |
|---|---|
| Auth logic | `src/auth/service.ts` |
| API error handling | `src/lib/api.ts` |
| Route protection | `src/components/AuthGuard.tsx` |
| Environment config | `.env` + `src/config.ts` |
| [Concern] | [File] |

---

## Dependencies Between Modules

```
auth/ → lib/api.ts → (external APIs)
components/ → store/ → auth/
pages/ → components/ → store/
```

---

## Entry Points

| Context | Start here |
|---|---|
| User-facing app | `src/main.tsx` |
| API routes | `src/routes/index.ts` |
| Auth flow | `src/auth/service.ts` |
| Tests | `tests/` |

---

*Last updated: [date]*
