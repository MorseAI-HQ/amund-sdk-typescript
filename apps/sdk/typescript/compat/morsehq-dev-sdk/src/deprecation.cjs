"use strict";
// CommonJS twin of deprecation.js — keep the two in sync (test/shim.test.mjs
// checks both). See deprecation.js for when the notice is suppressed.

const FLAG = Symbol.for("@morsehq-dev/sdk.deprecation-warned");

const MESSAGE =
  "morse: @morsehq-dev/sdk is deprecated and is now a thin re-export of @amund/sdk " +
  "(Morse is now Amund). Install @amund/sdk and change your imports from " +
  '"@morsehq-dev/sdk" to "@amund/sdk"; the API is identical. ' +
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
  return typeof value === "string" && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function nonBlank(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function shouldWarn() {
  try {
    if (typeof process !== "undefined" && process.noDeprecation) return false;
  } catch {
    // ignore
  }
  if (truthy(env("NODE_NO_WARNINGS"))) return false;
  if (truthy(nonBlank(env("AMUND_DISABLED")) ?? env("MORSE_DISABLED"))) return false;
  return true;
}

function warnDeprecatedOnce() {
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

module.exports = { MESSAGE, shouldWarn, warnDeprecatedOnce };
