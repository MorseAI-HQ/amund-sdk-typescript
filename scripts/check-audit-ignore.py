#!/usr/bin/env python3
"""Enforce the rules `.pip-audit-ignore` already states in prose.

That file has carried a re-verification rule since 2026-05-20:

    "an entry earns its place only while pip-audit still reports it. A stale
     entry is worse than no entry — it silently re-suppresses the finding if
     the dependency ever regresses to a vulnerable version."

Nothing checked it. A suppression list is the one place where doing nothing
looks identical to doing the right thing: the build stays green whether the
entry is a considered risk acceptance or a forgotten line from a triage nobody
remembers. This turns both halves of that rule into a gate.

Two failure modes, both silent until now:

  STALE    the ID is no longer reported by a bare audit. The dependency moved
           on. The line now does nothing — except re-suppress the finding if
           the version ever regresses.

  EXPIRED  the entry outlived its review-by date. "ACCEPT — not exploitable in
           our context" is a judgment about a codebase that has since changed.
           An expiry forces the judgment to be made again rather than inherited.

Usage:
    scripts/check-audit-ignore.py            # both checks
    scripts/check-audit-ignore.py --no-stale # skip the audit run (offline)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
IGNORE_FILE = REPO_ROOT / ".pip-audit-ignore"
API_DIR = REPO_ROOT / "apps" / "api"

# The pnpm half (MHQ-953). pnpm reads its suppressions from package.json ->
# pnpm.auditConfig.ignoreGhsas, which is JSON and therefore cannot carry a
# justification or a review-by date. So `.pnpm-audit-ignore` holds the prose
# and the expiry, package.json holds the machine-readable list, and the two are
# required to agree — otherwise a suppression could be added straight to
# package.json with no justification and nothing would notice.
PNPM_IGNORE_FILE = REPO_ROOT / ".pnpm-audit-ignore"
PACKAGE_JSON = REPO_ROOT / "package.json"

# `# expires: 2026-10-29` on a comment line preceding the ID it governs.
EXPIRES_RE = re.compile(r"^#\s*expires:\s*(\d{4}-\d{2}-\d{2})\s*$", re.IGNORECASE)
ID_RE = re.compile(r"^(CVE-[\d-]+|PYSEC-[\d-]+|GHSA-[\w-]+)\s*$")


def parse_ignore_file(
    path: Path = IGNORE_FILE,
) -> tuple[list[tuple[str, date | None]], list[str]]:
    """Return [(vuln_id, expiry_or_None)] and any parse problems."""
    if not path.is_file():
        return [], [f"{path.name} not found"]

    entries: list[tuple[str, date | None]] = []
    problems: list[str] = []
    pending_expiry: date | None = None

    for lineno, raw in enumerate(path.read_text().splitlines(), 1):
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            m = EXPIRES_RE.match(line)
            if m:
                try:
                    pending_expiry = datetime.strptime(m.group(1), "%Y-%m-%d").date()
                except ValueError:
                    problems.append(f"line {lineno}: unparseable expiry {m.group(1)!r}")
            continue
        if ID_RE.match(line):
            entries.append((line, pending_expiry))
            # An expiry governs the run of IDs beneath it, so it is NOT reset
            # here — a triage batch shares one review-by date, which is how the
            # file is already written.
        else:
            problems.append(f"line {lineno}: not a vulnerability ID: {line!r}")

    return entries, problems


def currently_reported() -> tuple[set[str], str | None]:
    """IDs a BARE audit reports — no --ignore-vuln. Returns (ids, error)."""
    try:
        proc = subprocess.run(
            ["uv", "run", "pip-audit", "--format", "json"],
            cwd=API_DIR,
            capture_output=True,
            text=True,
            timeout=600,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return set(), f"could not run pip-audit: {exc}"

    # pip-audit exits non-zero WHEN it finds vulnerabilities — that is the
    # expected path here, not an error. Only a missing/!JSON body is a failure.
    raw = proc.stdout.strip()
    if not raw:
        return (
            set(),
            f"pip-audit produced no JSON (exit {proc.returncode}): {proc.stderr[:200]}",
        )
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        return set(), f"could not parse pip-audit JSON: {exc}"

    found: set[str] = set()
    for dep in data.get("dependencies", []):
        for vuln in dep.get("vulns", []):
            if vid := vuln.get("id"):
                found.add(vid)
            for alias in vuln.get("aliases", []) or []:
                found.add(alias)
    return found, None


def pnpm_declared_ghsas() -> tuple[set[str], str | None]:
    """The IDs package.json actually suppresses. Returns (ids, error)."""
    try:
        data = json.loads(PACKAGE_JSON.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return set(), f"could not read package.json: {exc}"
    ignores = data.get("pnpm", {}).get("auditConfig", {}).get("ignoreGhsas", [])
    if not isinstance(ignores, list):
        return set(), "pnpm.auditConfig.ignoreGhsas is not a list"
    return set(ignores), None


#: pnpm's own tally of how many findings its ignore list suppressed, e.g.
#: "Severity: 2 low | 8 moderate | 2 high (2 ignored)".
PNPM_IGNORED_RE = re.compile(r"\((\d+)\s+ignored\)")


def pnpm_ignored_count() -> tuple[int | None, str | None]:
    """How many findings pnpm actually suppressed. Returns (count, error).

    Staleness is measured by COUNT, not by ID, because pnpm gives us no other
    handle: `--json` omits suppressed advisories from `advisories` entirely and
    leaves `muted` empty, and the ignore list is read from package.json, so
    there is no way to ask for an unsuppressed run without mutating the repo
    mid-check. Counting is coarser — it says "one of these is stale" rather
    than which — but it is pnpm's own accounting and it cannot produce the
    false STALE that an ID-diff against a suppressed run does. A check that
    tells you to delete a live exception is worse than no check.

    `--prod` deliberately, matching the CI gate: the dev/build tree is watched
    weekly by dependency-audit.yml and is not suppressible through this file.
    """
    try:
        proc = subprocess.run(
            ["pnpm", "audit", "--prod", "--no-color"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=600,
            env={**os.environ, "NO_COLOR": "1"},
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, f"could not run pnpm audit: {exc}"

    # A clean tree exits 0 and prints no severity line at all; that is not an
    # error, it means zero suppressions are doing anything.
    text = f"{proc.stdout}\n{proc.stderr}"
    m = PNPM_IGNORED_RE.search(text)
    if m:
        return int(m.group(1)), None
    if "vulnerabilities found" in text or proc.returncode == 0:
        return 0, None
    return (
        None,
        f"could not read an ignored-count from pnpm audit (exit {proc.returncode})",
    )


def check_pnpm(no_stale: bool) -> list[str]:
    """Expiry + staleness + package.json agreement. Returns failures."""
    failures: list[str] = []

    entries, problems = parse_ignore_file(PNPM_IGNORE_FILE)
    if problems:
        return [f".pnpm-audit-ignore could not be parsed: {'; '.join(problems)}"]

    documented = {vid for vid, _ in entries}
    declared, err = pnpm_declared_ghsas()
    if err:
        return [err]

    # The two lists must agree in BOTH directions.
    for vid in sorted(declared - documented):
        failures.append(
            f"{vid}: suppressed in package.json but absent from .pnpm-audit-ignore.\n"
            f"      A suppression with no justification or review-by date is permanent\n"
            f"      by default. Document it there, or drop it from package.json."
        )
    for vid in sorted(documented - declared):
        failures.append(
            f"{vid}: documented in .pnpm-audit-ignore but not in package.json's\n"
            f"      pnpm.auditConfig.ignoreGhsas — so it suppresses nothing and the\n"
            f"      prose is describing a state that does not exist."
        )

    today = date.today()
    for vid, expiry in entries:
        if expiry is None:
            failures.append(
                f"{vid}: no `# expires: YYYY-MM-DD` above it in .pnpm-audit-ignore."
            )
        elif expiry < today:
            failures.append(
                f"{vid}: expired {expiry} ({(today - expiry).days} days ago).\n"
                f"      Re-verify the justification and set a new date, or drop the entry."
            )
        else:
            print(f"  {vid}: expires {expiry} ({(expiry - today).days} days)")

    if no_stale:
        print("  (pnpm staleness check skipped — --no-stale)")
        return failures

    ignored, err = pnpm_ignored_count()
    if err:
        # Do NOT pass silently: an unrunnable audit is exactly the state in
        # which a stale entry hides.
        failures.append(f"pnpm staleness check could not run: {err}")
        return failures

    if ignored < len(entries):
        failures.append(
            f"STALE — .pnpm-audit-ignore documents {len(entries)} suppression(s) but\n"
            f"      `pnpm audit --prod` only suppressed {ignored}. At least one entry no\n"
            f"      longer matches a reported advisory: the dependency moved past it, and\n"
            f"      the line now only risks re-suppressing a regression. Run\n"
            f"      `pnpm audit --prod` and drop whichever entry it no longer reports."
        )
    else:
        print(f"  all {len(entries)} suppression(s) still matched a live advisory")
    return failures


def selftest() -> int:
    """Pin the parser: which lines are IDs, and which expiry governs each.

    The parser is the whole expiry check. If `ID_RE` stops recognising a real
    vulnerability ID, that entry silently vanishes from the list and its expiry
    is never enforced — the gate reports OK on a suppression it no longer sees.
    If `EXPIRES_RE` stops matching, every entry reads as undated and the gate
    fails loudly instead, which is the safe direction but equally wrong.
    """
    import tempfile

    def parse(body: str):
        with tempfile.NamedTemporaryFile(
            "w", suffix=".txt", delete=False, encoding="utf-8"
        ) as fh:
            fh.write(body)
            path = Path(fh.name)
        try:
            return parse_ignore_file(path)
        finally:
            path.unlink(missing_ok=True)

    d = date

    # (body, expected entries, expected problem count)
    cases: list[tuple[str, list[tuple[str, date | None]], int]] = [
        # The three ID shapes the file actually carries.
        (
            "# expires: 2099-01-01\nCVE-2024-1234\nPYSEC-2024-99\nGHSA-abcd-efgh-ijkl\n",
            [
                ("CVE-2024-1234", d(2099, 1, 1)),
                ("PYSEC-2024-99", d(2099, 1, 1)),
                ("GHSA-abcd-efgh-ijkl", d(2099, 1, 1)),
            ],
            0,
        ),
        # An expiry governs the RUN of IDs beneath it — a triage batch shares
        # one review-by date, which is how the file is written.
        (
            "# expires: 2026-01-01\nCVE-1\n# expires: 2027-06-30\nCVE-2\nCVE-3\n",
            [
                ("CVE-1", d(2026, 1, 1)),
                ("CVE-2", d(2027, 6, 30)),
                ("CVE-3", d(2027, 6, 30)),
            ],
            0,
        ),
        # An undated entry must survive parsing with expiry=None so main() can
        # fail it. Swallowing it here would make it permanent and invisible.
        ("CVE-2024-0001\n", [("CVE-2024-0001", None)], 0),
        # Prose comments are not expiries and must not become one.
        (
            "# ACCEPT — not exploitable in our context\n# reviewed by founder\nCVE-1\n",
            [("CVE-1", None)],
            0,
        ),
        # Blank lines and ordinary comments are skipped, not counted.
        (
            "\n\n# a comment\n\n# expires: 2099-01-01\nCVE-1\n",
            [("CVE-1", d(2099, 1, 1))],
            0,
        ),
        # Junk is reported rather than silently dropped.
        ("# expires: 2099-01-01\nnot-a-vuln-id\n", [], 1),
        # Date-SHAPED but impossible: reported, and the entry stays undated.
        ("# expires: 2026-13-45\nCVE-1\n", [("CVE-1", None)], 1),
        # Not date-shaped at all: read as an ordinary comment, so no parse
        # problem — the entry simply carries no expiry and main() fails it for
        # that. Pinned because it looks like a miss and is actually fail-closed.
        ("# expires: whenever\nCVE-1\n", [("CVE-1", None)], 0),
    ]

    failures = []
    for body, want_entries, want_problems in cases:
        entries, problems = parse(body)
        if entries != want_entries:
            failures.append(
                f"parse({body!r}) entries: got {entries}, want {want_entries}"
            )
        if len(problems) != want_problems:
            failures.append(
                f"parse({body!r}) problems: got {len(problems)} ({problems}), "
                f"want {want_problems}"
            )

    # A missing file is a problem, never an empty pass — an ignore file that
    # vanished would otherwise read as "no suppressions, all good".
    entries, problems = parse_ignore_file(Path("/nonexistent/.pip-audit-ignore"))
    if entries or not problems:
        failures.append("a missing ignore file must report a problem, not parse clean")

    if failures:
        print("check-audit-ignore --selftest: FAILED", file=sys.stderr)
        for f in failures:
            print(f"  ✗ {f}", file=sys.stderr)
        return 1

    print(
        f"check-audit-ignore --selftest: OK — {len(cases)} parse case(s) + missing-file."
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--no-stale",
        action="store_true",
        help="skip the staleness check (does not run pip-audit; offline-safe)",
    )
    parser.add_argument(
        "--selftest", action="store_true", help="pin the ignore-file parser"
    )
    args = parser.parse_args()

    if args.selftest:
        return selftest()

    entries, problems = parse_ignore_file()
    if problems:
        print("FAIL — .pip-audit-ignore could not be parsed cleanly:\n")
        for p in problems:
            print(f"  - {p}")
        return 1

    if not entries:
        print("OK — .pip-audit-ignore has no suppressions.")
        return 0

    print(f".pip-audit-ignore: {len(entries)} suppression(s)")
    failures: list[str] = []
    today = date.today()

    # --- expiry -----------------------------------------------------------
    for vid, expiry in entries:
        if expiry is None:
            failures.append(
                f"{vid}: no `# expires: YYYY-MM-DD` above it.\n"
                f"      A suppression with no review-by date is permanent by default."
            )
        elif expiry < today:
            failures.append(
                f"{vid}: expired {expiry} ({(today - expiry).days} days ago).\n"
                f"      Re-verify the justification and set a new date, or drop the line."
            )
        else:
            print(f"  {vid}: expires {expiry} ({(expiry - today).days} days)")

    # --- staleness --------------------------------------------------------
    if args.no_stale:
        print("\n(staleness check skipped — --no-stale)")
    else:
        reported, err = currently_reported()
        if err:
            # Do NOT pass silently: an unrunnable audit is exactly the state in
            # which a stale entry hides.
            failures.append(f"staleness check could not run: {err}")
        else:
            for vid, _ in entries:
                if vid not in reported:
                    failures.append(
                        f"{vid}: STALE — a bare `pip-audit` no longer reports it.\n"
                        f"      The dependency moved past it. Delete the line: while it\n"
                        f"      remains, a regression to a vulnerable version is silently\n"
                        f"      re-suppressed."
                    )

    # --- pnpm half (MHQ-953) ----------------------------------------------
    print("\n.pnpm-audit-ignore (production tree):")
    pnpm_failures = check_pnpm(args.no_stale)
    failures.extend(pnpm_failures)

    if failures:
        print(f"\nFAIL — {len(failures)} problem(s) in the audit suppression lists:\n")
        for f in failures:
            print(f"  - {f}\n")
        return 1

    print("\nOK — every suppression is current, dated, and still reported.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
