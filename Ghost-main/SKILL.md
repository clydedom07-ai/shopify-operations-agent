---
name: context-optimizer
description: >
  Minimizes token/context usage in Claude Code and long sessions without
  sacrificing model capability or output quality. Activates automatically
  when working on coding projects, long debugging sessions, multi-file
  exploration, or when the user mentions session limits, context bloat,
  or slowdowns. Also triggered by /scope, /compress, /handoff, /resume commands.
version: 1.0.0
triggers:
  - claude code session
  - session limit
  - context window
  - long session
  - /scope
  - /compress
  - /handoff
  - /resume
  - token usage
---

# Context Optimizer Skill

## Mission

Maximize useful signal per token. Every turn should move the task forward
with the smallest context footprint possible — without dropping capability,
accuracy, or output quality. You are not cutting corners. You are cutting noise.

---

## Memory Hierarchy (non-negotiable)

| Tier | File | What lives here |
|------|------|-----------------|
| 1 — Permanent | `CLAUDE.md` | Project rules, stack, commands, conventions. Never repeated in chat. |
| 2 — Session | `docs/session-handoff.md` | Current task state, files touched, next exact step, blockers. |
| 2 — Decisions | `docs/decision-log.md` | Architecture choices, why they were made, what was rejected. |
| 2 — Map | `docs/context-map.md` | Module ownership, key interfaces, where to edit common concerns. |
| 3 — Scratchpad | Live chat | Temporary reasoning only. Expendable. |

Rule: **If it matters beyond this turn, it belongs in a Tier 1 or Tier 2 file — not in chat.**

---

## Default Workflow (every session)

### On Start
1. Check `CLAUDE.md` → know the project without asking.
2. Check `docs/session-handoff.md` → know exactly where to resume.
3. Restate the task in ≤3 bullets. Name the exact files you'll touch.
4. If no `CLAUDE.md` exists → run `/init` or generate one now using the template.

### On Each Task
- Load only the files needed for this specific task. Not the whole repo.
- If >3 files seem relevant, create a minimal shortlist with reasons first.
- Work in targeted prompts: "Edit `auth.ts`, update `login()` to validate JWT expiry, run auth tests" — not "fix auth."

### On Milestone Complete
1. Update `docs/session-handoff.md` with current state.
2. Log any architecture decisions in `docs/decision-log.md`.
3. Run `/compress` to summarize and free context.

### On Task Switch
1. Write handoff state to `docs/session-handoff.md`.
2. Run `/clear` (new unrelated task = new session).
3. Resume with: "Read CLAUDE.md and session-handoff.md. Continue: [next step]."

---

## Compression Rules

When compressing or summarizing prior context:
- **Keep**: task goal, key decisions, exact filenames, current state, next action, open blockers.
- **Drop**: failed hypotheses (unless still open), repetitive explanation, raw debug logs already resolved.
- **Format**: structured bullets, not prose walls.
- Target: compress a 100k token history into a ~2-3k summary with zero capability loss.

Trigger `/compress` when:
- A feature is complete.
- A debugging loop has run 3–5 turns without resolution.
- Discussion feels repetitive.
- Context feels heavy/slow.

---

## Tool Discipline

- **Disable** search/research/MCP connectors unless that specific step needs them.
- **Disable** extended thinking unless the task genuinely requires multi-step reasoning.
- **After** a large file read or search result → decide immediately: keep or clear.
- Never leave large tool outputs sitting in context after they've been acted on.

---

## Prompting Rules (enforce these)

Always scope before acting:
> "Summarize the task in 3 bullets, name exact files needed, ignore unrelated repo parts."

Always compress on switch:
> "Compress prior discussion into: decisions made, open questions, next action. Then clear."

Always handoff cleanly:
> "Update session-handoff.md and decision-log.md. Write a resume note under 150 words."

---

## Anti-Patterns (never do these)

| Anti-pattern | Why it's bad |
|---|---|
| Repeating full project context in every prompt | CLAUDE.md exists for this |
| One mega-session for unrelated features | Cross-task residue pollutes context |
| Leaving connectors/search enabled all session | Token-intensive, confirmed by Anthropic |
| Vague prompts like "fix auth" or "improve this" | Forces broad exploration = token explosion |
| Keeping stale project files in context | Anthropic explicitly recommends removing these |
| Storing reasoning in chat instead of memory files | Chat is not persistent memory |

---

## Custom Commands

| Command | Action |
|---|---|
| `/scope` | Restate task, list exact files, ignore everything else |
| `/compress` | Summarize history → decisions + state + next step. Drop noise. |
| `/handoff` | Write full state to session-handoff.md. Prepare for /clear. |
| `/resume` | Load CLAUDE.md + session-handoff.md. Restate exact next step. |
| `/audit` | List what's in context. Flag anything that can be cleared or moved to files. |

See `commands/` folder for full prompts for each command.

---

## Guiding Principle

> Chat is a scratchpad. Files are memory. Treat them that way.

The goal is not fewer tokens at the cost of quality — it's **zero wasted tokens**
while keeping every token that actually matters. A clean 20k context outperforms
a bloated 180k context every time.
