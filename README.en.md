# dsh-plan-guard

[中文](README.md) | English

**Planning skills + write-time assertion plugins for DSH.** The skills make the model think before it acts; the plugins catch it re-committing the exact mistakes that have already burned you. Neither half tries to be a general framework — both only encode things that actually happened.

> This repo was not designed from scratch. It's the fallout of two videos: one on *how to think clearly before writing code* (the Grilling / Brainstorming / Explore planning frameworks), one on *how to know you haven't broken anything after* (turning "is it right?" from eyeballing into automatic assertions). The conclusion after watching: **the first video's landing point is a prompt artifact — a skill is enough. The second one's landing point is architecture — a skill can't help; you have to hook DSH's interception seams.** This repo is both of those made real.

---

## What's in here

| | Planning (`skills/`) | Assertions (`plugins/`) |
|---|---|---|
| Solves | The problem wasn't thought through before acting | Something got quietly broken after acting |
| Form | Prompt artifact (`SKILL.md`) | DSH plugins (hooked into `tools/pre-execute` / `tools/post-execute`) |
| When it fires | When you or the model load it | Automatically, on every file write |
| Portable? | **Open Agent Skills format — works in Claude Code etc.** | DSH-specific |

```
dsh-plan-guard/
├── skills/                       ① Three planning skills
│   ├── grilling/                 adversarial one-question-at-a-time interviewing
│   ├── brainstorming/            9-step flow, forces a design doc + self-review
│   └── explore/                  read first, no artifacts by default
├── plugins/                      ② Two DSH assertion plugins
│   ├── dsh-skill-lint/           three assertions for SKILL.md
│   └── dsh-script-lint/          three assertions for shell / PowerShell
├── docs/background.md            where this came from, and why each decision
├── install.sh / install.ps1      install the skills
├── uninstall.sh / uninstall.ps1  remove the skills
└── install-plugins.sh            install the plugins into a profile
```

---

## Install

### Skills

```bash
git clone https://github.com/wjingshan/dsh-plan-guard.git
cd dsh-plan-guard
bash install.sh          # macOS / Linux
```

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1   # Windows
```

Installs into `$DSH_HOME/skills` (default `~/.dsh/skills`) — the **user-level** skill root, active in every project. **No restart needed**: DSH watches these directories, so new skills show up in the next conversation step.

For a single project instead, copy the directories into `<project root>/.dsh/skills/` (higher priority, shadows the global copy).

### Plugins

```bash
bash install-plugins.sh
```

This does two things: copies both packages into `<profile>/node_modules/`, then appends `insert` entries to `<profile>/cordis.patch.yml`.

**It copies rather than symlinks** — Node resolves modules by realpath (`preserveSymlinks: false`), so a symlinked plugin would look for `@deepseek-ai/schemastery` next to its *source* directory, where there is no `node_modules`.

On Windows, do those same two steps by hand — see the Chinese README for the exact commands. The profile's `patchReload` is `live`, so no restart.

---

## The three planning skills

| Skill | Metaphor | What it does |
|---|---|---|
| **grilling** | An aggressive interviewer | One question at a time, down the design tree, no "good enough" answers |
| **brainstorming** | A strict project manager | Nine steps, ends in a committed design doc plus self-review |
| **explore** | A curious thinking partner | Read code, compare options, ASCII diagrams — **produces no artifacts** |

Load with `/grilling`, `/brainstorming`, `/explore`, or just say "poke holes in this plan".

---

## The two assertion plugins

### dsh-skill-lint

DSH's skill loader has two **silent** failure modes — it fails, and you can't tell.

`FM_INVALID` · `NAME_MISSING` · `NAME_NOT_KEBAB` · `NAME_MISMATCH` · `DESC_MISSING` · `BOOL_INVALID` · `SIZE_OVER`

Any of the first six means DSH **silently discards the whole skill**. The model can't tell "this skill doesn't exist" from "this skill is malformed"; only a warning lands in the log.

### dsh-script-lint

All three rules come from real incidents:

| Code | Catches | From |
|---|---|---|
| `SHELL_ERREXIT_TRAP` | Under `set -e`, `x=$(... grep ...)` failing **kills the whole script with no error** | A packaging script exited 1 silently; took a long time to find |
| `SHELL_GREP_UNQUOTED_PATH` | Recursive `grep` with an unquoted `$VAR` | `grep -rn ... $D` with `$D` empty → recursively searched the entire workspace |
| `PS1_NO_BOM` | `.ps1` with non-ASCII but no UTF-8 BOM | PowerShell 5.1 decodes it as ANSI; Chinese turns to mojibake |

`SHELL_ERREXIT_TRAP` is the subtle one, because it encodes bash semantics — **position and shell options change the answer**:

| Form | Under `set -e` | |
|---|---|---|
| `x=$(grep a f)` | the substitution's exit code **is** the assignment's | ❌ |
| `echo $(grep a f)` / `[ -n "$(…)" ]` / `for f in $(…)` | doesn't affect the outer status | ✅ |
| `x=$(ls \| grep v \| wc -l)` without `pipefail` | only the last stage counts | ✅ |
| same, **with `pipefail`** | **any** stage failing counts | ❌ |
| `x=$(grep a f \|\| true)` | failure explicitly swallowed | ✅ |
| `x=$(grep a f) \| cat` | runs in a subshell; can't kill the script | ✅ |
| `cat f \| { x=$(grep a f); }` | the compound returns non-zero — **still fatal** | ❌ |

So the message names **every** fragile stage in the pipeline, not just the first — naming only the first sends you to fix the wrong line.

---

## Three design decisions

**1. Criteria and seams are separate.** Each plugin's `src/` splits into pure-function criteria (`lint.mjs` / `rules.mjs` — zero dependencies, independently testable) and thin seam wiring (`index.mjs`). A wrong measurement and a wrong criterion can be audited separately, without one masking the other. Borrowed from `dsh-design-audit`'s own "measurement and criteria are separate" principle.

**2. The two seams behave differently — this is the design, not an implementation detail.**

- `write` → `tools/pre-execute` → `deny`: the content hasn't landed yet, so the bad file **never exists**.
- `edit` → `tools/post-execute` → `block`: `edit` takes `{old_string, new_string}`, so the new full text **doesn't exist** before the call. It can only re-read from disk afterwards and report. And it **cannot undo** what already landed.

We deliberately don't undo. An assertion that claims "I rolled it back" without rolling anything back is more dangerous than one that plainly says "this file is now broken".

**3. Prefer over-reporting, but keep criteria narrow.** A missed report is silent; an extra one is at least visible — hence no path restriction by default. But a linter noisy enough to disable is the same as no linter, so each rule only fires on high-confidence shapes, and every rule was verified against the real scripts in this repo for zero false positives.

---

## Tests

```bash
node --test plugins/dsh-skill-lint/test/*.test.mjs     # 24 assertions
node --test plugins/dsh-script-lint/test/*.test.mjs    # 39 assertions
```

`dsh-script-lint`'s headline fixture is the real buggy line from the packaging script — **the pre-fix version must be caught, and adding `|| true` must clear it**.

---

## Known limits

1. **Only intercepts DSH's `write` / `edit` tools.** `cp`, an editor, or any shell command writing a file **bypasses this entirely**.
2. **Not a bash parser.** Line-by-line, quote-aware scanning. `eval`, `${!x}` and friends are invisible to it.
3. **Both plugins hook `tools/pre-execute`, and the first `deny` in the waterfall short-circuits** — a file tripping both sides reports one issue at a time.
4. **This is not a regression suite.** No case corpus, no scoreboard, no feature-flag A/B, no coverage. Assertions prevent repeating a known mistake; they don't prove a change broke nothing else.

Point 4 is deliberate: that machinery (non-determinism, cost, LLM-judge signal-to-noise) is an order of magnitude harder. Don't build it before your scale demands it.

---

## License

MIT
