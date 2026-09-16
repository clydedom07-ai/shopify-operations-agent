# Custom Commands Reference

Drop these into Claude Code as custom slash commands, or use them as prompt templates.

---

## /scope

Use at the START of any task to prevent unnecessary file loading.

```
Scope this task before acting:
1. Restate the goal in ≤3 bullets.
2. List the EXACT files needed — nothing else.
3. If >3 files seem needed, explain why each one is necessary.
4. Ignore unrelated parts of the repo unless I explicitly ask.
Do not start working until the scope is confirmed.
```

---

## /compress

Use after a milestone or when context feels heavy.

```
Compress prior conversation context now:
1. Summarize all key DECISIONS made (not the discussion — just the outcomes).
2. List OPEN QUESTIONS that are still unresolved.
3. State the NEXT ACTION in one sentence.
4. Drop: failed hypotheses already resolved, repeated explanations, raw debug logs, old file contents.
Output this as a structured block under 200 words.
Then treat this summary as the new working context — the full history above it is no longer needed.
```

---

## /handoff

Use BEFORE switching tasks or ending a session.

```
Write a session handoff now:
1. Update docs/session-handoff.md with:
   - Current task goal
   - What's done
   - What's in progress (be exact — file, function, line if relevant)
   - Next exact step
   - Files touched
   - Open blockers
2. Log any architecture decisions made this session in docs/decision-log.md.
3. Output a resume note under 150 words that I can paste to start the next session cold.
```

---

## /resume

Use at the START of a fresh session to reload state without chat history.

```
Resume the previous session:
1. Read CLAUDE.md — internalize all project rules, stack, and conventions.
2. Read docs/session-handoff.md — load current task state and next step.
3. Confirm what you know: task goal, next action, files you'll touch.
4. Do NOT ask me to re-explain context that's already in those files.
5. Begin immediately from the next exact step.
```

---

## /audit

Use when you suspect context is bloated or cluttered.

```
Audit the current context:
1. What large content is currently in context that could be cleared? (file reads, search results, old tool outputs)
2. What information is being kept in chat that should be moved to CLAUDE.md or docs/?
3. What tool outputs can be re-fetched on demand and cleared now?
4. Recommend: what to clear, what to compress, what to keep.
Output as a prioritized list. Then execute the top recommendations.
```

---

## /init (new project setup)

Use when starting a brand new project to establish memory files.

```
Initialize the context memory system for this project:
1. Scan the repo structure and generate CLAUDE.md using the template in context-optimizer-skill/templates/CLAUDE.md.
   Fill in: project purpose, stack, commands, key files, architecture rules.
2. Create docs/session-handoff.md using the template. Fill in current task.
3. Create docs/decision-log.md (empty, ready for first entries).
4. Create docs/context-map.md with current module overview.
Do this now. These files are the project's persistent memory — get them right.
```
