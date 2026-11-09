#!/usr/bin/env python3
"""Mine Claude Code session transcripts for signals a self-improvement pass can act on.

usage: python3 -I mine-sessions.py [--dir DIR] [--since YYYY-MM-DD] [--json]
Default DIR is ~/.claude/projects/<this repo>. Read-only. Prints:
  - failed tool calls grouped by tool and normalized message (wasted effort)
  - human prompts that look like corrections (the agent got it wrong or quit early)
  - repeated human instructions (candidates for a skill or memory)
  - Bash command prefixes (candidates for an allowlist or helper script)
"""
import argparse, collections, datetime, glob, json, os, re, subprocess, sys

REDACT = [
    (re.compile(r'\b(sk|ghp|gho|ghs|xox[bp]|gls)[-_][A-Za-z0-9_-]{12,}'), '[token]'),
    (re.compile(r'Bearer\s+\S+', re.I), 'Bearer [token]'),
    (re.compile(r'\b[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*[=:]\s*\S+'), '[secret]'),
    (re.compile(r'\b[0-9a-f]{32,}\b'), '[hex]'),
]


def redact(text):
    for rx, rep in REDACT:
        text = rx.sub(rep, text)
    return text


def default_dir():
    # Claude Code stores a repo's sessions under ~/.claude/projects/<repo path with / as ->
    try:
        top = subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip()
    except Exception:
        return ''
    return os.path.expanduser('~/.claude/projects/' + top.replace('/', '-'))


def instant(ts):
    # parse an ISO timestamp (or YYYY-MM-DD) into an aware UTC datetime; None if it cannot be parsed
    if not ts:
        return None
    try:
        dt = datetime.datetime.fromisoformat(ts.replace('Z', '+00:00'))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=datetime.timezone.utc)


ap = argparse.ArgumentParser()
ap.add_argument('--dir', default=default_dir(), help='session folder (default: derived from the git repo)')
ap.add_argument('--since', default='')
ap.add_argument('--json', action='store_true')
ap.add_argument('--verbose', action='store_true', help='include example tool input (redacted)')
a = ap.parse_args()
SINCE = instant(a.since) if a.since else None
if a.since and SINCE is None:
    sys.exit('--since must be a date or an ISO 8601 timestamp, e.g. 2026-11-08T21:40:00Z')


def after(ts):
    # strictly after the boundary; an undated event cannot be placed, so it is left out when --since is set
    if SINCE is None:
        return True
    t = instant(ts)
    return t is not None and t > SINCE
if not a.dir or not glob.glob(os.path.join(a.dir, '*.jsonl')):
    sys.exit(f'no session files found in {a.dir!r}; pass --dir')

CORR = re.compile(r"\b(no[,. ]|don'?t|stop|wrong|not what|why did you|you (forgot|missed|didn)|still (the same|getting|failing|seeing)|what did i tell|are you sure|try again|that'?s not|i said|i asked)\b", re.I)
errs = collections.Counter()
err_ex = {}
corr = []
prompts = collections.Counter()
bash = collections.Counter()
sessions = 0
per_session = collections.Counter()


def prompt_text(c):
    # a human prompt is a string, or a list of blocks when an image is attached
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return ' '.join(b.get('text', '') for b in c if isinstance(b, dict) and b.get('type') == 'text')
    return ''


for f in glob.glob(os.path.join(a.dir, '*.jsonl')):
    pend, active = {}, False
    with open(f, errors='ignore') as fh:
        lines = fh.readlines()
    for line in lines:
        try:
            d = json.loads(line)
        except Exception:
            continue
        if not after(d.get('timestamp')):
            continue
        active = True
        m = d.get('message') or {}
        c = m.get('content')
        t = d.get('type')
        if t == 'user' and (d.get('origin') or {}).get('kind') == 'human':
            s = prompt_text(c).strip()
            if s and not s.startswith('<'):
                prompts[redact(re.sub(r'\s+', ' ', s[:60].lower()))] += 1
                if CORR.search(s[:200]) and len(s) < 400:
                    corr.append((os.path.basename(f)[:8], redact(s[:200].replace('\n', ' '))))
        if t == 'assistant' and isinstance(c, list):
            for b in c:
                if b.get('type') == 'tool_use':
                    pend[b['id']] = (b['name'], json.dumps(b.get('input'))[:200])
                    if b['name'] == 'Bash':
                        bash[' '.join((b['input'].get('command') or '').split()[:2])] += 1
        if t == 'user' and isinstance(c, list):
            for b in c:
                if b.get('type') == 'tool_result' and b.get('is_error'):
                    name, inp = pend.get(b.get('tool_use_id'), ('?', ''))
                    txt = b.get('content')
                    txt = txt if isinstance(txt, str) else json.dumps(txt)
                    key = (name, redact(re.sub(r'\d+', 'N', txt[:110])))
                    errs[key] += 1
                    err_ex.setdefault(key, redact(inp))
                    per_session[os.path.basename(f)[:8]] += 1
    sessions += active

out = {
    'sessions': sessions,
    'failed_tool_calls': [{'n': n, 'tool': k[0], 'msg': k[1], **({'example_input': err_ex[k]} if a.verbose else {})} for k, n in errs.most_common(40)],
    'corrections': corr[:80],
    'repeated_prompts': [(p, n) for p, n in prompts.most_common(15) if n > 1],
    'bash_prefixes': bash.most_common(25),
    'sessions_by_failures': per_session.most_common(10),
}
if a.json:
    print(json.dumps(out, indent=1))
else:
    print(f"{sessions} sessions with events in period")
    print('\n## Failed tool calls')
    for r in out['failed_tool_calls']:
        print(f"{r['n']:>3}x {r['tool']}: {r['msg']}")
    print('\n## Sessions with the most failed calls (file id, count)')
    for sid, n in out['sessions_by_failures']:
        print(f'{n:>4} {sid}')
    print('\n## Correction-like prompts (session, text)')
    for s, t in out['corrections']:
        print(f'- [{s}] {t}')
    print('\n## Repeated prompts')
    for p, n in out['repeated_prompts']:
        print(f'{n:>3}x {p}')
    print('\n## Bash prefixes')
    for p, n in out['bash_prefixes']:
        print(f'{n:>4} {p}')
