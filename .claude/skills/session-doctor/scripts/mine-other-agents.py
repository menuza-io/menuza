#!/usr/bin/env python3
"""Mine Codex and Droid (factory.ai) session transcripts, like mine-sessions.py does for Claude Code.

usage: python3 -I mine-other-agents.py [--root PATH ...] [--since ISO8601] [--verbose]
Read-only. A session is in scope when its cwd is a --root or inside one (default: this git repo).
--since takes a date or a full UTC timestamp (2026-11-08T21:40:00Z); only events after it count.
Codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
Droid:  ~/.factory/sessions/<cwd-slug>/<id>.jsonl
Antigravity keeps conversations as binary protobuf in ~/.gemini/antigravity/conversations,
which cannot be read here. Its readable record is ~/.gemini/antigravity/brain/<id>/*.md
(task, implementation_plan, walkthrough): grep those instead.
"""
import argparse, collections, datetime, glob, json, os, re, subprocess

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


try:
    _top = subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip()
except Exception:
    _top = ''
ap = argparse.ArgumentParser()
ap.add_argument('--root', action='append', default=[_top] if _top else [],
                help='checkout root; repeat for several (default: this repo)')
ap.add_argument('--since', default='')
ap.add_argument('--verbose', action='store_true', help='list the sessions with the most failures')
a = ap.parse_args()
H = os.path.expanduser('~')
ROOTS = [r.rstrip('/') for r in a.root if r]
CORR = re.compile(r"\b(no[,. ]|don'?t|stop|wrong|not what|why did you|you (forgot|missed|didn)|still (the same|getting|failing|seeing)|what did i tell|are you sure|try again|that'?s not|i said|i asked)\b", re.I)
NOISE = ('Your standard model budget', "You've reached your", 'Reply with exactly', 'Background task', '# Task Tool Invocation')


def in_scope(cwd):
    return any(cwd == r or cwd.startswith(r + '/') for r in ROOTS)


def instant(ts):
    # parse an ISO timestamp (or YYYY-MM-DD) into an aware UTC datetime; None if it cannot be parsed
    if not ts:
        return None
    try:
        dt = datetime.datetime.fromisoformat(ts.replace('Z', '+00:00'))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=datetime.timezone.utc)


SINCE = instant(a.since) if a.since else None
if a.since and SINCE is None:
    raise SystemExit('--since must be a date or an ISO 8601 timestamp, e.g. 2026-11-08T21:40:00Z')


def after(ts):
    # strictly after the boundary; an undated event cannot be placed, so it is left out when --since is set
    if SINCE is None:
        return True
    t = instant(ts)
    return t is not None and t > SINCE


class Stats:
    def __init__(self):
        self.files = self.scoped = self.active = self.msgs = self.limit = 0
        self.tools = collections.Counter()
        self.errs = collections.Counter()
        self.per_session = collections.Counter()
        self.corr = []


def show(name, st):
    print(f'\n######## {name}: {st.files} files, {st.scoped} in scope, {st.active} with events in period, '
          f'{st.msgs} user messages parsed, {sum(st.tools.values())} tool calls')
    if not st.files:
        print('WARNING: no session files found; check the path')
    elif st.scoped and st.msgs == 0:
        print('WARNING: zero user messages parsed; the schema may have changed')
    if not ROOTS:
        print('WARNING: not in a git repo and no --root given; nothing is in scope')
    print('tools:', st.tools.most_common(10))
    if st.limit:
        print(f'sessions with a usage-limit event in period (estimate, matched by message shape): {st.limit}')
    print('## failed tool calls')
    for (t, m), c in st.errs.most_common(20):
        print(f'{c:>4}x {t}: {redact(m)}')
    if a.verbose:
        print('## sessions with the most failed calls (file id, count)')
        for sid, c in st.per_session.most_common(10):
            print(f'{c:>4} {sid}')
    print('## correction-like prompts')
    for s in st.corr[:30]:
        print('-', redact(s))


def read(f):
    with open(f, errors='ignore') as fh:
        return fh.readlines()


# ---- Codex
cx = Stats()
for f in glob.glob(H + '/.codex/sessions/*/*/*/*.jsonl'):
    cx.files += 1
    sid = os.path.basename(f)[-14:-6]
    cwd, pend, on, active, seen = '', {}, False, False, set()
    for line in read(f):
        try:
            d = json.loads(line)
        except Exception:
            continue
        p = d.get('payload') or {}
        t = p.get('type')
        if d.get('type') == 'session_meta':
            cwd = p.get('cwd', '')
            on = in_scope(cwd)
            cx.scoped += on
        if not on or not after(d.get('timestamp')):
            continue
        active = True
        text = None
        if d.get('type') == 'event_msg' and t == 'item_completed':
            it = p.get('item') or {}
            if it.get('type') == 'UserMessage':
                text = ' '.join(c.get('text', '') for c in it.get('content', []))
        elif d.get('type') == 'event_msg' and t == 'user_message':
            text = p.get('message') or ''  # older rollouts
        if text is not None:
            s = text.strip()
            if s and not s.startswith('<') and s not in seen:
                seen.add(s)
                cx.msgs += 1
                if CORR.search(s[:200]) and len(s) < 400:
                    cx.corr.append(s[:180].replace('\n', ' '))
        if d.get('type') == 'response_item' and t in ('function_call', 'custom_tool_call'):
            cx.tools[p.get('name')] += 1
            pend[p['call_id']] = p.get('name')
        if d.get('type') == 'response_item' and t in ('function_call_output', 'custom_tool_call_output'):
            o = str(p.get('output'))
            m = re.search(r'"exit_code":\s*(-?\d+)', o)
            if m and m.group(1) != '0':
                i = o.find('"output"')
                cx.errs[(pend.get(p.get('call_id'), '?'), re.sub(r'\d+', 'N', o[i:i + 110].replace('\\n', ' ')))] += 1
                cx.per_session[sid] += 1
    cx.active += active
show('CODEX', cx)

# ---- Droid
dr = Stats()
for f in glob.glob(H + '/.factory/sessions/*/*.jsonl'):
    dr.files += 1
    sid = os.path.basename(f)[:8]
    cwd, pend, on, active, hit = '', {}, False, False, False
    for line in read(f):
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get('type') == 'session_start':
            cwd = d.get('cwd', '')
            on = in_scope(cwd)
            dr.scoped += on
        if not on or not after(d.get('timestamp')):
            continue
        active = True
        m = d.get('message') or {}
        c = m.get('content')
        if d.get('type') != 'message' or not isinstance(c, list):
            continue
        for b in c:
            if b.get('type') == 'tool_use':
                dr.tools[b['name']] += 1
                pend[b['id']] = b['name']
            elif b.get('type') == 'tool_result' and b.get('is_error'):
                tx = b.get('content')
                tx = tx if isinstance(tx, str) else json.dumps(tx)
                dr.errs[(pend.get(b['tool_use_id'], '?'), re.sub(r'\d+', 'N', tx[:100].replace('\n', ' ')))] += 1
                dr.per_session[sid] += 1
            elif b.get('type') == 'text' and m.get('role') == 'user':
                s = b['text'].strip()
                # a limit event is a harness message at the start of a user turn, not text the user typed
                if m.get('visibility') == 'user_only' and (s.startswith('Your standard model budget is exhausted') or (
                        s.startswith("You've reached your") and 'usage limit' in s[:120] and 'resets in' in s)):
                    hit = True
                if s and not s.startswith('<') and not s.startswith(NOISE):
                    dr.msgs += 1
                    if CORR.search(s[:200]) and len(s) < 400:
                        dr.corr.append(s[:180].replace('\n', ' '))
    dr.active += active
    dr.limit += 1 if hit else 0
show('DROID', dr)
