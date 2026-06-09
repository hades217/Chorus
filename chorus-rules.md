# Chorus Rules for AI Agents

Copy these rules into your AI assistant's configuration file
(e.g., `.claude/rules/`, `.cursorrules`, `AGENTS.md`).

---

## Rule 1: Normalize PRDs on contact

Every time you read or touch a PRD, check if it has proper YAML frontmatter.
If not, add it immediately:

```yaml
---
title: "Extract from the first H1 heading"
date: YYYY-MM-DD
status: draft
owner: "@developer-name"
---
```

## Rule 2: Infer status from content

When adding status to a PRD that has none:

| Signal | Status |
|--------|--------|
| All checkboxes checked | `done` |
| >50% checkboxes checked | `in-progress` |
| <50% checkboxes checked | `draft` |
| "deprecated" or "legacy" in title | `archived` |
| No checkboxes, pure documentation | `draft` |

## Rule 3: Before starting any task

1. Search `docs/` for a related PRD
2. If a PRD exists → read it, normalize it (Rule 1), then work
3. If no PRD exists and the task is non-trivial → create one from `docs/prd/TEMPLATE.md`

## Rule 4: Update status during work

```
draft → in-progress    (when you start working)
in-progress → review   (when all acceptance criteria are checked)
review → done          (when all test plan items pass)
any → blocked          (when a blocker is discovered — add a note)
```

## Rule 5: Check off items immediately

- `- [ ]` → `- [x]` the moment each item is verified
- Do NOT batch — check each item as soon as it's done

## Rule 6: Regenerate dashboard after changes

```bash
node scripts/generate-prd-dashboard.mjs
```

## Rule 7: Batch normalize when asked

If between tasks or asked to "clean up PRDs", scan `docs/` and normalize
all PRDs that lack proper frontmatter.

## Rule 8: PRD changes must reach Git

A status change that only lives in your working tree is invisible to the
rest of the team. After updating a PRD:

- **If the change accompanies code work** → include the PRD file in the
  same commit as the code (`git add src/... docs/prd/...`)
- **If it's a standalone PRD change** (status flip, new PRD, priority
  change) → commit and push it immediately:

```bash
git add docs/prd/<file>.md docs/DASHBOARD.md
git commit -m "chorus: <prd-name> → <new-status>"
git push
```

Never leave PRD changes uncommitted at the end of a task.

> **Note:** If the board is running with `CHORUS_GIT_SYNC=1`, the server
> auto-commits and pushes every PRD change (including ones you make by
> editing the file directly) within ~10s — so this rule is handled for you.
> Rule 8 is the fallback for when auto-sync is off.

---

## Automating these rules

Rules 1–8 cover work as it happens, but boards still drift over time.
The **chorus-steward** subagent (`.claude/agents/chorus-steward.md`)
audits the whole board on demand — detecting status drift against git
history, fixing frontmatter, flagging stale PRDs, and reporting what
needs attention. In Claude Code:

```
> Use the chorus-steward agent to audit the PRDs
```

Run it daily or whenever the board feels out of sync with reality.
