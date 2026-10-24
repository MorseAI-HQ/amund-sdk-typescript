import json
import shutil
import tempfile
import unittest
from datetime import date
from pathlib import Path

from check_forge_audit_exception import GHSA, PATCH, validate


class ExceptionGuardTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        source = Path(__file__).resolve().parents[2]
        for name in [
            "package.json",
            "pnpm-lock.yaml",
            PATCH,
            ".github/workflows/ci.yml",
        ]:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / name, target)

    def check(self, day=date(2026, 10, 2)):
        return validate(self.root, day)

    def test_reviewed_configuration_passes(self):
        self.assertEqual(self.check(), [])

    def test_expires_on_exclusive_end_date(self):
        self.assertEqual(self.check(date(2026, 11, 26)), [])
        self.assertTrue(self.check(date(2026, 11, 27)))

    def test_missing_or_changed_patch_fails(self):
        patch = self.root / PATCH
        patch.write_text(patch.read_text() + "changed\n")
        self.assertTrue(self.check())
        patch.unlink()
        self.assertTrue(self.check())

    def test_unpatched_consumer_fails(self):
        lock = self.root / "pnpm-lock.yaml"
        text = lock.read_text()
        start = text.index("node-forge: 1.4.0(patch_hash=")
        end = text.index("\n", start)
        lock.write_text(text[:start] + "node-forge: 1.4.0" + text[end:])
        self.assertTrue(self.check())

    def test_missing_patch_configuration_fails(self):
        package = self.root / "package.json"
        config = json.loads(package.read_text())
        config["pnpm"]["patchedDependencies"].pop("node-forge@1.4.0")
        package.write_text(json.dumps(config))
        self.assertTrue(self.check())

    def test_changed_lock_hash_fails(self):
        lock = self.root / "pnpm-lock.yaml"
        lock.write_text(
            lock.read_text().replace("2rrcoti7slk4yhkia7s4hfdtpe", "changed")
        )
        self.assertTrue(self.check())

    def test_missing_regression_command_fails(self):
        workflow = self.root / ".github/workflows/ci.yml"
        workflow.write_text(
            workflow.read_text().replace(
                "pnpm test:security:node-forge", "echo skipped"
            )
        )
        self.assertTrue(self.check())

    def test_removed_exception_restores_normal_audit(self):
        package = self.root / "package.json"
        config = json.loads(package.read_text())
        config["pnpm"]["auditConfig"]["ignoreGhsas"].remove(GHSA)
        package.write_text(json.dumps(config))
        (self.root / PATCH).unlink()
        self.assertEqual(self.check(date(2026, 10, 17)), [])


if __name__ == "__main__":
    unittest.main()
