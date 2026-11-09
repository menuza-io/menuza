# Session doctor log

Aggregate counts only. Do not paste prompts, paths, repo names, tokens or model
names from transcripts here.

## 2026-11-08 first runs (mining only, no rubric scoring)

Run boundary (UTC): 2026-11-08T21:39:36Z. The next run uses `--since` with this
value.

Sources: Claude Code (167 sessions), Codex (87 in scope), Droid (163 in scope).
Antigravity conversations are binary and were not read.

| Signal                                                  | Count    |
| ------------------------------------------------------- | -------- |
| Ad-hoc `gh api` PR-comment calls                        | about 72 |
| Bash calls blocked on approval for shell expansion      | 12       |
| Subagent concurrency-limit errors                       | 7        |
| Worker sessions that hit a usage limit during a fan-out | 24       |
| Failed `Read` calls on paths that do not exist          | about 70 |
| `Edit` failures, text not found                         | 18+      |
| Commits blocked by the Lingui check                     | 3        |

Changes: `pr-review-loop` skill and script, session miners, AGENTS.md gotchas.

Baseline rubric scores: none yet. The next run should score a sample with
`rubrics/` and record the numbers here.
