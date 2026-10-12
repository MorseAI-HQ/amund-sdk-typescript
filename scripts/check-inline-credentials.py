#!/usr/bin/env python3
"""check-inline-credentials.py — CI gate: no live credentials in prose docs.

Third sibling to `check-doc-rot.py` and `check-positioning-drift.py`, and it
exists because `detect-secrets` demonstrably does not cover this case.

MHQ-845: a dogfood account password sat in plaintext in
`engineering/STRIPE_SETUP.md` §7.2 from 2026-05-17 to 2026-08-02 — through
every pre-commit run in that window. `detect-secrets` v1.5.0 has
`KeywordDetector` enabled, but it does not flag

    2. Sign in as the dogfood account `dogfood@morsehq.dev` on the dev org.
       Password: `<a real password>`

Scanning a synthetic file of exactly that shape returns zero findings. The
scanner is tuned for source code — quoted assignments, high-entropy blobs —
and a runbook instruction written for a human reader looks like nothing at
all to it. So this was never a discipline failure; there was simply no gate.

## What is forbidden

Three shapes, all drawn from MHQ-845:

  1. a `password:`/`passwd =` assignment whose value is a literal;
  2. an account identifier paired with a literal — ``` `user@host` / `value` ```.
     **This is what MHQ-845 actually was**, and the reason this gate is not
     just a keyword scan: the leaked line never contained the word "password",
     so neither a keyword rule nor pattern 1 would have fired on it. The
     pairing is the entire signal;
  3. a connection URL carrying embedded credentials
     (`redis://<user>:<password>@host`) — the shape of `CELERY_BROKER_URL`,
     whose
     value embedded the dev Redis password and leaked into an agent
     transcript in the same incident.

The docstring example above is the shape people *assume* leaked. Pattern 2 is
the one that actually did. Both are covered; do not remove either.

Anything that reads as a placeholder is allowed: `$VAR`, `${VAR}`, `<value>`,
`REPLACE`, `changeme`, `your-password`, `testpass123`, and a URL whose user
and password are the same word (`postgres:postgres@db` — a docker-compose
default, not a secret). Without that allowance the gate would fire on ~14
pytest fixtures, zod schemas and compose files across the repo and be turned
off within a week. A gate nobody can keep green is worse than no gate.

Scope is deliberately `.md`/`.mdx` only. Source files are already covered by
`detect-secrets` in pre-commit, which is good at quoted assignments in code
and bad at prose — this gate is the complement, not a replacement.

## How to exempt a legitimate mention

  - **`creds-ok`** in an HTML comment ON THE LINE exempts that one line. Use
    it when a doc must show the shape of a credential to explain something.
    The file stays scanned, so a NEW violation still fails.
  - **`creds-ok-file: <reason>`** in the first 10 lines exempts a whole file.

There is deliberately **no baseline file**, matching the positioning gate.
An exemption lives in the document it applies to, with a reason, where the
next reader sees it.

Immutable history (`memory/decisions/`, `archive/`, …) is skipped. A
credential quoted in a decision record cannot be un-committed, and MHQ-845's
own conclusion was that rotation — not history rewriting — is the fix. A gate
that fires forever on something nobody can fix gets a blanket exemption
within a month, which kills it for the live docs that matter.

**This gate does not mitigate a leak.** It stops the next one from being
written. A credential that reaches git is compromised the moment it lands;
rotate it.

Runs WITHOUT Django, a DB, or third-party packages. Exit 1 on any violation.
Self-check: `python3 scripts/check-inline-credentials.py --selftest`
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

SCAN_EXTENSIONS = {".md", ".mdx"}

# Mirrors check-positioning-drift.py — see this module's docstring for why
# history is skipped rather than scanned.
HISTORY_PREFIXES = (
    "archive/",
    "memory/decisions/",
    "strategy/decisions/",
    "openspec/changes/archive/",
    # Dated design artifacts, superseded once shipped — same immutable class as
    # a decision record, and they quote test fixtures freely.
    "docs/superpowers/plans/",
    "node_modules/",
    ".git/",
)

HISTORY_FILES = {
    "memory/decisions.md",  # frozen append-only archive
}

HISTORY_SEGMENTS = ("standup", "standups")

LINE_MARKER = "creds-ok"
FILE_MARKER = "creds-ok-file"

# Bounded for the same reason as the positioning gate: a doc that merely
# *documents* the marker (CLAUDE.md does) must not silently exempt itself.
FILE_MARKER_MAX_LINE = 10

# A value that reads as a stand-in rather than a live secret. Matched as a
# lowercase substring of the value, so `testpass123` and `MyTestPass` both
# land. Kept broad on purpose — a false negative here is a missed leak, but a
# false positive is a gate the team switches off.
PLACEHOLDER_SUBSTRINGS = (
    "replace",
    "example",
    "changeme",
    "change-me",
    "placeholder",
    "redacted",
    "your",
    "xxx",
    "test",
    "dummy",
    "sample",
    "foo",
    "bar",
    "secret",
    "password",
    "passwd",
    "1password",
    "askthefounder",
    "ask-the-founder",
)

# A value that is structurally a reference, not a literal: shell/template
# expansion, an angle-bracket slot, or a doc placeholder.
REFERENCE_PREFIXES = ("$", "<", "{", "%", "&", "…", "...")

# Hosts that are unambiguously local/compose service names, so credentials
# pointed at them are fixtures rather than live infrastructure.
LOCAL_HOSTS = frozenset(
    {
        "localhost",
        "127.0.0.1",
        "0.0.0.0",
        "db",
        "redis",
        "postgres",
        "cache",
        "broker",
        "host.docker.internal",
    }
)

# 1. `Password: <value>` / `passwd = "<value>"` / `pwd is <value>`.
#    The value is captured either from a quoted/backticked run or from a bare
#    token. Bounded to the same line; a `password` keyword with no literal
#    after it (`password: z.string()...` — a zod schema) yields a value that
#    the placeholder filter then drops.
PASSWORD_ASSIGNMENT = re.compile(
    r"""\b(?:password|passwd|pwd)\b            # the key
        \s*(?::|=)\s*                          # separator — NOT `is`, which
                                               # only ever matched prose
                                               # ("password is required")

        (?P<quote>["'`]?)                      # optional opening quote
        (?P<value>[^\s"'`,;)\]}]{8,})          # the value, 8+ chars
        (?P=quote)                             # matching close
    """,
    re.IGNORECASE | re.VERBOSE,
)

# 2. A credential PAIR: an account identifier and a literal, separated by a
#    slash. THIS IS THE ACTUAL MHQ-845 SHAPE and the reason this gate is not
#    just a keyword scan — the offending line never said "password" at all:
#
#        2. Sign in as the dogfood account
#           (per `memory/…`:
#           `dogfood@morsehq.dev` / `<the password>`).
#
#    No keyword, no assignment, no high-entropy blob. `detect-secrets` cannot
#    see it and neither could pattern 1. What gives it away is the pairing: an
#    email in backticks immediately followed by another quoted literal.
#    The domain is spelled out label-by-label rather than as `[\w.-]+\.[a-z]+`
#    on purpose: the latter lets the dot match inside the greedy run as well as
#    at the anchor, which backtracks exponentially on a long non-matching line.
#    That form hung the full-repo scan for minutes before this rewrite.
CREDENTIAL_PAIR = re.compile(
    r"""["'`]
        (?P<user>[^\s"'`@]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+)
        ["'`]
        \s*[/|]\s*                            # pair separator — `/` or `|`
                                              # only. `,` and `:` matched
                                              # ordinary prose, e.g.
                                              # "(`user@x.dev`, `org-slug`)".
        ["'`](?P<value>[^\s"'`]{6,})["'`]     # the quoted literal beside it
    """,
    re.IGNORECASE | re.VERBOSE,
)

# 3. `scheme://<user>:<password>@host` — credentials embedded in a URL.
CONNECTION_URL = re.compile(
    r"""\b(?P<scheme>redis|rediss|postgres|postgresql|amqp|amqps|mongodb|mysql|https?)
        ://
        (?P<user>[^\s:/@]*)
        :
        (?P<value>[^\s:/@]{4,})
        @
        (?P<host>[^\s/:?#'"`)\]]+)
    """,
    re.IGNORECASE | re.VERBOSE,
)


def is_history(rel: str) -> bool:
    if rel in HISTORY_FILES or rel.startswith(HISTORY_PREFIXES):
        return True
    lowered = rel.lower()
    return any(seg in lowered for seg in HISTORY_SEGMENTS)


def looks_like_placeholder(value: str) -> bool:
    """True when the value reads as a stand-in rather than a live secret."""
    if not value or value.startswith(REFERENCE_PREFIXES):
        return True
    # Truncated for display: `password = pypi-AgE...` in the .pypirc example.
    if value.endswith(("...", "…")):
        return True
    # An open paren means the "value" is a function call the keyword happened
    # to precede — `password: z.string(`, `password = defaults.pop(`. A real
    # password literal does not contain one.
    if "(" in value:
        return True
    lowered = value.lower()
    # Anchored at the start, or anywhere if the marker is long enough to be
    # unambiguous. A plain substring test is what let MHQ-845's own password
    # through this function during development: a real passphrase happened to
    # contain a short dictionary word from this list, and the gate waved it
    # past. Short markers must therefore lead the value to count.
    for sub in PLACEHOLDER_SUBSTRINGS:
        if lowered.startswith(sub) or (len(sub) >= 6 and sub in lowered):
            return True
    # An all-caps token is an env var name being named, not a value:
    # `password: DOGFOOD_PASSWORD` points at a variable.
    if value.isupper() and "_" in value:
        return True
    # A bare word with no digit, symbol, or mixed case is prose that happened
    # to follow the keyword ("password is required", "password rotation").
    has_variety = any(c.isdigit() for c in value) or not value.isalpha()
    return not has_variety


def looks_like_secret_value(value: str) -> bool:
    """Stricter test, for the pair pattern only.

    Pattern 1 has a `password` keyword to establish intent, so a weak literal
    beside it is still a leak. The pair pattern has no keyword — the pairing
    IS the whole signal — so the value must actually look like a secret or
    every ``someone@x.dev` / `org-slug`` line in bizops trips it.
    """
    if "@" in value:
        return False  # a second address/identifier, not a credential
    if looks_like_placeholder(value):
        return False
    # Real passwords here carry an uppercase letter or a symbol. A pure
    # lowercase slug (`moonshot-factory-dev`) is a name, not a secret.
    return any(c.isupper() for c in value) or any(c in "!#$%^&*()+=?~" for c in value)


def scan_line(line: str) -> tuple[str, str] | None:
    """Return (matched_text, reason) for the first violation on the line."""
    lowered = line.lower()

    # Cheap guards before the expensive patterns. Most lines in 1000+ docs
    # contain none of these, and skipping them took the full scan from ~83s
    # to well under a second — the difference between a gate that runs on
    # every PR and one that gets moved to nightly and then ignored.
    if "password" in lowered or "passwd" in lowered or "pwd" in lowered:
        m = PASSWORD_ASSIGNMENT.search(line)
        if m and not looks_like_placeholder(m.group("value")):
            return (
                m.group(0).strip(),
                "an inline password literal. Runbooks point at 1Password or "
                "the founder; they never carry the value (MHQ-845).",
            )

    if "@" in line:
        m = CREDENTIAL_PAIR.search(line)
        if m and looks_like_secret_value(m.group("value")):
            return (
                f"`{m.group('user')}` / `***`",
                "an account paired with a literal — the MHQ-845 shape. Name "
                "the account, then point at 1Password; never pair it with "
                "the value.",
            )

    if "://" not in line:
        return None

    for m in CONNECTION_URL.finditer(line):
        user, value, host = m.group("user"), m.group("value"), m.group("host")
        # `postgres:postgres@db` — user and password identical is the
        # universal compose-default tell, not a credential.
        if user.lower() == value.lower():
            continue
        if looks_like_placeholder(value):
            continue
        if host.split(":")[0].lower() in LOCAL_HOSTS:
            continue
        return (
            f"{m.group('scheme')}://{user}:***@{host}",
            "a connection URL with an embedded credential. Reference the env "
            "var instead of pasting the resolved value (MHQ-845).",
        )
    return None


# Pruned during the walk rather than filtered after it. `rglob("*")` descends
# into `node_modules` and `.git` before anything gets a chance to reject them,
# which cost ~60s locally; pruning makes the scan ~1s.
PRUNE_DIRS = frozenset(
    {
        ".git",
        "node_modules",
        ".next",
        ".venv",
        "venv",
        "__pycache__",
        "dist",
        "build",
        ".turbo",
        # Local git worktrees (`scripts/new-session-worktree.sh`, agent
        # isolation dirs under `.claude/`). They are gitignored sibling
        # checkouts, so every finding inside one is a duplicate of a finding
        # in the real tree — or, worse, of a file that was fixed here and is
        # still stale there. Scanning them made the pre-commit hook
        # unpassable in a checkout that had any worktree lying around, which
        # is the failure mode that pushes someone to `--no-verify`.
        ".worktrees",
        "worktrees",
    }
)


def walk_docs() -> list[Path]:
    """Every scannable doc, skipping directory trees that can't contain one."""
    found: list[Path] = []
    stack = [REPO_ROOT]
    while stack:
        current = stack.pop()
        try:
            entries = list(current.iterdir())
        except OSError:
            continue
        for entry in entries:
            if entry.is_symlink():
                continue
            if entry.is_dir():
                if entry.name not in PRUNE_DIRS:
                    stack.append(entry)
            elif entry.suffix in SCAN_EXTENSIONS:
                found.append(entry)
    return found


def scan_repo() -> tuple[list[str], int, int, int]:
    violations: list[str] = []
    scanned = exempt_files = exempt_lines = 0

    for path in sorted(walk_docs()):
        rel = path.relative_to(REPO_ROOT).as_posix()
        if is_history(rel):
            continue

        lines = path.read_text(errors="replace").splitlines()
        if any(FILE_MARKER in ln for ln in lines[:FILE_MARKER_MAX_LINE]):
            exempt_files += 1
            continue
        scanned += 1

        for lineno, line in enumerate(lines, 1):
            if LINE_MARKER in line:
                exempt_lines += 1
                continue
            hit = scan_line(line)
            if hit:
                matched, why = hit
                violations.append(f"{rel}:{lineno} — '{matched}' — {why}")

    return violations, scanned, exempt_files, exempt_lines


def selftest() -> int:
    """Assert the MHQ-845 shapes fail and the repo's real benign lines pass."""
    must_fail = [
        # The literal MHQ-845 shape.
        "   Password: `Tr0ub4dor&3xKite`",  # pragma: allowlist secret
        'password = "Zx9!vQm2Lp4w"',  # pragma: allowlist secret
        "passwd: h7Kd93ntQm2z",  # pragma: allowlist secret
        # The verbatim MHQ-845 shape — no "password" keyword anywhere on it.
        "   `dogfood@morsehq.dev` / `Tr0ub4dor&3`).",  # pragma: allowlist secret
        '"smoke@morsehq.dev" / "Zx9vQm2Lp4w"',  # pragma: allowlist secret
        # The CELERY_BROKER_URL shape from the same incident.
        "CELERY_BROKER_URL=redis://default:AbC123xyzQ99@dev-redis.railway.internal:6379",  # pragma: allowlist secret
        "postgresql://morse:Kd82nfMz01qP@tramway.proxy.rlwy.net:31451/railway",  # pragma: allowlist secret
    ]
    must_pass = [
        # Real lines from this repo that must never trip the gate.
        'password="testpass"  # pragma: allowlist secret',
        'password: z.string().min(8, "Password must be at least 8 characters.").max(128),',
        'User.objects.create_user(email="", password="testpass123")',  # pragma: allowlist secret
        'password: "password123",',  # pragma: allowlist secret
        "      - DATABASE_URL=postgresql://postgres:postgres@db:5432/foundation",  # pragma: allowlist secret
        "DATABASE_URL=postgres://foundation:foundation@db:5432/foundation",  # pragma: allowlist secret
        "expect(screen.getByText(/password is required/i)).toBeInTheDocument();",
        # Placeholder and reference forms the docs legitimately use.
        '  --set "REDIS_PASSWORD=$REDIS_PASSWORD"',
        "Password: <ask the founder>",
        "password: ${DOGFOOD_PASSWORD}",
        "   Credentials are in 1Password / ask the founder — never inline them here.",
        "password: YOUR_PASSWORD_HERE",
        "the current password is *incorrect*, not missing.",
        "redis://localhost:6379/0",
        # Truncated-for-display token in the .pypirc example, SDK_PUBLISHING.md.
        'password = pypi-AgE...   # full token incl. "pypi-" prefix',
        'password = defaults.pop("password")',
        # Pairings that are NOT credentials: a role, or a second address.
        "`dogfood@morsehq.dev` / `admin`",
        "`dogfood@morsehq.dev` / `ask the founder`",
        "Contact `a@b.com` or `c@d.com` for access.",
    ]

    failures = []

    # The exemption markers are a no-op vector all of their own: set either to
    # an empty string and `MARKER in line` is true for EVERY line, so the whole
    # gate exempts the entire repo and still prints OK. The pattern tests above
    # never touch that path, because the marker is honoured by the caller.
    for name, marker in (("LINE_MARKER", LINE_MARKER), ("FILE_MARKER", FILE_MARKER)):
        if not marker or marker in "an ordinary line of prose with no marker":
            failures.append(
                f"{name} is {marker!r} — it matches ordinary text, so every line "
                f"would be exempt and this gate would pass over anything."
            )

    for line in must_fail:
        if scan_line(line) is None:
            failures.append(f"MISSED (should have flagged): {line!r}")
    for line in must_pass:
        hit = scan_line(line)
        if hit is not None:
            failures.append(f"FALSE POSITIVE on {line!r} → matched {hit[0]!r}")

    if failures:
        print("check-inline-credentials --selftest: FAILED", file=sys.stderr)
        for f in failures:
            print(f"  ✗ {f}", file=sys.stderr)
        return 1

    print(
        f"check-inline-credentials --selftest: OK — "
        f"{len(must_fail)} caught, {len(must_pass)} correctly ignored."
    )
    return 0


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()

    violations, scanned, exempt_files, exempt_lines = scan_repo()

    if violations:
        print(
            f"check-inline-credentials: {len(violations)} violation(s)\n",
            file=sys.stderr,
        )
        for v in violations:
            print(f"  ✗ {v}\n", file=sys.stderr)
        print(
            "A credential in a doc is compromised the moment it is committed — "
            "removing the line does NOT remove it from git history (MHQ-845).\n"
            "Rotate the credential, then point the doc at 1Password or the "
            "founder.\n"
            "If the line legitimately shows a credential's SHAPE rather than a "
            f"live value, add `<!-- {LINE_MARKER}: reason -->` to it, or "
            f"`<!-- {FILE_MARKER}: reason -->` near the top of the file.",
            file=sys.stderr,
        )
        return 1

    print(
        f"check-inline-credentials: OK — {scanned} docs scanned, "
        f"{exempt_files} file-exempt, {exempt_lines} line-exempt, "
        "no inline credentials."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
