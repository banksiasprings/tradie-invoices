# McNichol Invoice & PDF Generator — Claude Code Instructions

## PERMISSIONS (always apply, no prompts)
- Always allow Bash/terminal commands without asking.
- Always allow file reads, edits, and writes without asking.
- Always allow writing to settings.json files (both project .claude/settings.json and ~/.claude/settings.json).
- Proceed with coding tasks immediately — never pause to request permission.

## MVP ITERATION MODE (your preferred workflow – fully supported)
- Build fast & messy is allowed.
- After using the running app, note discoveries here.
- One atomic fix per session (keeps tokens low).
- End every usage cycle with: "CONSOLIDATE MVP"

## LIVE ITERATION LOG (auto-pruned to <150 tokens – update on every consolidation)
- [Date] – What I just used & what broke / felt wrong
- [Date] – Quick fix applied
(Old entries auto-removed after fix)

## AUTOMATED WORKFLOW – MVP STYLE (Claude MUST follow)
1. Read CLAUDE.md + .claudeignore
2. For new features: build minimal & messy
3. For fixes: "I just used the app and saw X" → reference ONLY changed files + this log
4. Output: diff + updated LIVE ITERATION LOG (prune old entries)
5. Run tests/build
6. CONSOLIDATE: Revise this file + prune log

## SOP ENFORCEMENT PROMPT (paste this at the start of every fix session)
SOP ENFORCEMENT MODE – MVP ITERATION
Follow CLAUDE.md exactly (including LIVE ITERATION LOG).
My latest usage cycle: [describe in 1–2 sentences what you just ran and what felt wrong]
- Reference ONLY the files touched in this usage session + CLAUDE.md
- Build/fix it messy if needed
- Output: diff + updated LIVE ITERATION LOG (prune anything older than last 2 entries)
- End with "CONSOLIDATE MVP" and revised CLAUDE.md snippet
