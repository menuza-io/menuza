# Rubric: followed instructions

Did the agent obey AGENTS.md, the loaded skills, memory and the user's explicit
instructions in this conversation?

Scores: 1.0 all followed; 0.6 one minor miss; 0.4 a miss the user had to
correct; 0.2 repeated misses; 0.0 ignored a hard rule. Pass is 0.6 or above.

Look for:

- the user correcting the agent ("I said", "what did I tell you", "are you
  sure")
- a hard rule from AGENTS.md broken (dev servers, `.env` edits, `db:reset`,
  Playwright on a developer machine without asking, `BASE_URL` override)
- a PR comment fixed without validating it, or only one of several comments
  fixed
- unrequested scope: extra refactors, data migrations (the user has zero users),
  new docs
- tests, lint, typecheck or `node scripts/check-lingui.mjs` skipped before a
  commit
- claiming success without running the check

Output: score, pass or fail, and the exact rule that was missed with where it is
written.
