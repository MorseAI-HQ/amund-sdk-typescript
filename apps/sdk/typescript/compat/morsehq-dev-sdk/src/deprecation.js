// One-time deprecation notice for the `@morsehq-dev/sdk` compatibility shim.
// Keep in sync with deprecation.cjs (the CommonJS twin); test/shim.test.mjs
// exercises both.
//
// Printed at most once per process, across every subpath and across ESM + CJS
// (the flag lives on globalThis under a registry symbol, so both module
// systems see the same one). Stays quiet when:
//   - AMUND_DISABLED / MORSE_DISABLED is truthy (the SDK itself is a no-op),
//   - Node deprecation output is off (`--no-deprecation` / process.noDeprecation),
//   - NODE_NO_WARNINGS=1.
// Never throws into the host application.

const FLAG = Symbol.for("@morsehq-dev/sdk.deprecation-warned");

export const MESSAGE =
  "morse: @morsehq-dev/sdk is deprecated and is now a thin re-export of @amundai/sdk " +
  "(Morse is now Amund). Install @amundai/sdk and change your imports from " +
  '"@morsehq-dev/sdk" to "@amundai/sdk"; the API is identical. ' +
  "MORSE_* environment variables keep working (AMUND_* takes precedence).";

function env(name) {
  try {
    if (typeof process !== "undefined" && process.env) {
      const v = process.env[name];
      return typeof v === "string" ? v : undefined;
    }
  } catch {
    // Sandboxes where process.env access throws.
  }
  return undefined;
}

function truthy(value) {
  return (
    typeof value === "string" && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase())
  );
}

function nonBlank(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function shouldWarn() {
  try {
    if (typeof process !== "undefined" && process.noDeprecation) return false;
  } catch {
    // ignore
  }
  if (truthy(env("NODE_NO_WARNINGS"))) return false;
  if (truthy(nonBlank(env("AMUND_DISABLED")) ?? env("MORSE_DISABLED"))) return false;
  return true;
}

export function warnDeprecatedOnce() {
  try {
    if (globalThis[FLAG]) return;
    globalThis[FLAG] = true;
    if (!shouldWarn()) return;
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn(MESSAGE);
    }
  } catch {
    // Never break the importing application.
  }
}

warnDeprecatedOnce();
