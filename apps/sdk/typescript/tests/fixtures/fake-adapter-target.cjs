// Minimal CJS fixture used by tests/auto-detect.test.ts to stand in for a
// "target package" without depending on the real (heavy, possibly ESM-only)
// npm packages the SDK auto-detects in production. Its absolute path is
// registered as a temporary key in `_internalsForTesting.FULL_INSTALL_TARGETS`
// / `DETECT_ONLY_TARGETS` for the duration of a test.
module.exports = { marker: "fake-adapter-target" };
