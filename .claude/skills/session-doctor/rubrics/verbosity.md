# Rubric: verbosity

Is the agent overly wordy in its messages, commits, PR bodies, or code comments?
Review is the bottleneck, so extra words and noise cost the reviewer.

Scores: 1.0 tight; 0.8 slightly long; 0.6 some filler; 0.4 comments that narrate
the code; 0.2 walls of text or a changelog nobody asked for; 0.0 unreadable.
Pass is 0.6 or above.

Look for:

- code comments that restate what the next line does
- final summaries that repeat the diff
- tests that duplicate coverage already given by an existing test
- PR bodies longer than the change warrants

Output: score, pass or fail, and one example quoted.
