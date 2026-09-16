# Context Optimizer Skill

# Ghost

> Run lean. Stay sharp. Go longer.

Ghost is a context optimization skill for Claude that eliminates token waste without touching model capability. Sessions last longer. Outputs stay sharp. Nothing is compromised.

Two versions. One repo

---

## Versions

| Version | For | How it works |
|---|---|---|
| `Ghost.md` | Claude.ai (browser/app) | Upload via `+` → Skills. Runs silently in every chat. |
| `context-optimizer-skill/SKILL.md` | Claude Code (terminal) | Drop in `.claude/skills/`. Uses file-based memory system. |

---

## The Problem

Claude sessions die fast — not because the model is weak, but because context fills up with garbage:

- Full conversation history replaying every single turn
- File reads sitting idle after they've been acted on
- Repeated project context that should live in one file
- One mega-session bleeding across 6 unrelated tasks
- Connectors and tools enabled all session for a step that took 2 minutes

Result: bloated context → slower reasoning → session limits in 30–60 minutes.

Ghost fixes all of it.

---

## Version 1 — Claude.ai (Ghost.md)

**Install**: `+` → Skills → upload `Ghost.md`

Ghost activates automatically in every Claude.ai conversation and:

- **Scopes tasks** before acting — loads only what's needed, ignores everything else
- **Compresses silently** when history grows — keeps decisions, drops noise
- **Switches context cleanly** when you change topics — no cross-task residue
- **Disciplines tool use** — no unnecessary web searches or raw output carryover
- **Answers exactly** what's asked — no padding, no re-explaining

### Commands

| Command | What happens |
|---|---|
| `/scope` | Restate task in 3 bullets, identify exact info needed |
| `/compress` | Summarize session — decisions, state, next step. Drop noise. |
| `/snapshot` | Generate a copyable block to resume this session later |
| `/resume` | Paste a prior snapshot — Ghost picks up exactly where you left off |
| `/clear` | Acknowledge topic switch, drop prior task context |
| `/audit` | Show what's in context, what can be dropped |

### Session Snapshot

The `/snapshot` command generates a resume block you can copy and paste into a new session:

```
GHOST SESSION SNAPSHOT
─────────────────────
Task: [current goal]
Done: [completed items]
Open: [unresolved items]
Key decisions: [list]
Next step: [exact action]
─────────────────────
```

Paste it with `/resume` in any new chat. Zero context loss across sessions.

---

## Version 2 — Claude Code (context-optimizer-skill/)

**Install**: Drop `context-optimizer-skill/SKILL.md` into `.claude/skills/` in your project.

Copy the templates into your project:

```
your-project/
├── CLAUDE.md                        ← permanent project memory
├── docs/
│   ├── session-handoff.md           ← resume point between sessions
│   ├── decision-log.md              ← architecture decisions, out of chat
│   └── context-map.md               ← module map, navigate without reading files
```

Ghost enforces a 3-tier memory system:

```
Tier 1 — CLAUDE.md          Permanent rules. Read once per session. Never repeated in chat.
Tier 2 — docs/              Session state, decisions, module map. Survives /clear.
Tier 3 — Live chat          Temporary scratchpad. Expendable.
```

### Session Flow

```
START    → Read CLAUDE.md + session-handoff.md → scope task
WORK     → Touch only needed files
DONE     → /compress → update handoff + decision-log
SWITCH   → /handoff → /clear → /resume
```

### Commands

| Command | Action |
|---|---|
| `/scope` | Restate task, list exact files, ignore everything else |
| `/compress` | Summarize history → decisions + state + next step |
| `/handoff` | Write full state to session-handoff.md |
| `/resume` | Load CLAUDE.md + handoff, continue from next exact step |
| `/audit` | Flag what can be cleared or moved to files |
| `/init` | Generate all memory files for a new project |

Full command prompts in `context-optimizer-skill/commands/commands.md`.

---

## What Changes

| Before Ghost | After Ghost |
|---|---|
| Session limits in 30–60 min | Sessions that actually last |
| Full project context every prompt | Lives in CLAUDE.md / memory, referenced once |
| File reads sitting in context | Cleared after use, re-fetched on demand |
| One session for everything | Task-scoped, clean switches |
| Vague prompts → broad exploration | Scoped prompts → targeted execution |
| Cross-task context pollution | Clean slate on topic switch |

---

## Repo Structure

```
Ghost/
├── Ghost.md                              ← Claude.ai skill (upload this)
├── README.md
├── LICENSE
└── context-optimizer-skill/             ← Claude Code skill
    ├── SKILL.md                          ← upload/drop this
    ├── commands/
    │   └── commands.md                   ← slash command prompts
    └── templates/
        ├── CLAUDE.md
        ├── session-handoff.md
        ├── decision-log.md
        └── context-map.md
```

---

## Important

Ghost reduces **wasted** tokens — not useful ones. It does not bypass Anthropic's service limits. What it does: make every token count, so the same budget goes dramatically further.

A clean 20k context beats a bloated 180k context. Every time.

---

## License

MIT — free to use, modify, and build on.

---

*Built by [Nistal](https://github.com/NISTALTALSON) — because hitting session limits every 30 minutes gets old fast.*
---

*context-optimizer-skill v1.0.0*
