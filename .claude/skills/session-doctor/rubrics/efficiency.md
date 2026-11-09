# Rubric: efficiency

Did the agent work toward the result, or waste effort on redundant steps and
back and forth? Judge from the tool calls, not the final summary. Agents work
around roadblocks silently, so a successful run can still hide a broken
instruction.

Scores: 1.0 direct; 0.8 minor detours; 0.6 some retries; 0.4 repeated failed
calls or exploring the environment; 0.2 mostly spinning; 0.0 never converged.
Pass is 0.6 or above.

Look for:

- the same tool call failing 2+ times, or a failed call followed by a workaround
- re-reading the same file, re-running the same command with no change
- guessing ports, paths, env var names or flags that a skill or AGENTS.md should
  state
- asking the user something the repo already answers
- stopping early ("should I continue?") when the user asked to continue until
  done
- hitting a permission prompt that a helper script or allowlist rule would avoid
- starting more subagents than the concurrency limit

Output: score, pass or fail, and one sentence naming the specific wasted step
and which skill, doc or setting would have prevented it.
