"""Fail closed on the founder's bounded, exact-patch Forge audit exception."""

import hashlib
import json
import re
from datetime import date
from pathlib import Path

GHSA = "GHSA-86w9-cpqp-85rv"
EXPIRES = date(2026, 10, 16)  # Exclusive: no automatic renewal.
PATCH = "patches/node-forge@1.4.0.patch"
SHA256 = "9a9dc718cb1ca29b6c679a8faccebd42f089bf0f6cb313948d79c3371b884236"  # pragma: allowlist secret — public patch digest
PATCH_HASH = "2rrcoti7slk4yhkia7s4hfdtpe"


def validate(root: Path, today: date) -> list[str]:
    package = json.loads((root / "package.json").read_text())
    pnpm = package.get("pnpm", {})
    ignores = pnpm.get("auditConfig", {}).get("ignoreGhsas", [])
    if GHSA not in ignores:
        return []  # Removal of the exception restores the ordinary audit gate.
    errors = []
    if today >= EXPIRES:
        errors.append(
            f"Forge exception expired {EXPIRES}; remove or obtain a new risk decision"
        )
    if pnpm.get("patchedDependencies", {}).get("node-forge@1.4.0") != PATCH:
        errors.append("Forge exception requires the reviewed patchedDependencies entry")
    patch = root / PATCH
    if not patch.is_file() or hashlib.sha256(patch.read_bytes()).hexdigest() != SHA256:
        errors.append("Forge exception requires the exact reviewed patch SHA256")
    lock = (root / "pnpm-lock.yaml").read_text()
    declaration = f"  node-forge@1.4.0:\n    hash: {PATCH_HASH}\n    path: {PATCH}\n"
    if declaration not in lock:
        errors.append("Forge lockfile patch declaration differs from the approved hash")
    resolutions = re.findall(r"^\s+node-forge: (.+)$", lock, re.MULTILINE)
    expected = f"1.4.0(patch_hash={PATCH_HASH})"
    if not resolutions or any(value != expected for value in resolutions):
        errors.append(
            "Every Forge consumer must resolve the exact reviewed patched version"
        )
    workflow = (root / ".github/workflows/ci.yml").read_text()
    if not re.search(r"^\s+pnpm test:security:node-forge\s*$", workflow, re.MULTILINE):
        errors.append("Required frontend Forge regression command is missing")
    return errors


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[2]
    try:
        problems = validate(root, date.today())
    except (OSError, ValueError, TypeError) as exc:
        problems = [f"Cannot verify Forge exception prerequisites: {exc}"]
    for problem in problems:
        print(problem)
    if not problems:
        print("Forge audit exception prerequisites: OK")
    raise SystemExit(bool(problems))
