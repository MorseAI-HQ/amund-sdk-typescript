/**
 * Deployment identity detected once at `init()` (ATTR-06, MHQ-1275): the git
 * revision the process runs, and the `service.version` an operator declared.
 *
 * Both ride the trace `resource` on the JSON path (`git.revision`,
 * `service.version`) and the OTel `Resource` on the OTLP path, so a trace can
 * be tied to the code that produced it without any per-call API.
 *
 * Git revision, first match wins:
 *
 *   1. `MORSE_GIT_REVISION`      — explicit override; the Docker-image answer
 *   2. `GITHUB_SHA`              — GitHub Actions
 *   3. `CI_COMMIT_SHA`           — GitLab CI
 *   4. `RAILWAY_GIT_COMMIT_SHA`  — Railway
 *   5. `VERCEL_GIT_COMMIT_SHA`   — Vercel
 *   6. `RENDER_GIT_COMMIT`       — Render
 *   7. `SOURCE_VERSION`          — Heroku
 *   8. `git rev-parse HEAD`      — Node only, and only if `child_process` is reachable
 *
 * Why the last step is loaded the way it is: this module ships in the browser
 * and edge bundles too, where a static `child_process` import is a build error
 * in the customer's bundler (`scripts/check-sdk-browser-bundle.mjs` fails the
 * release on exactly that). So the builtin is never named in an `import` or
 * `require("...")` — it is fetched at run time through
 * `process.getBuiltinModule` (Node 20.16+/22.3+, identical in ESM and CJS),
 * falling back to a run-time-eval'd `require` for older CJS. Same technique as
 * `tracing.ts::tryLoadAls`. Anywhere neither exists (browsers, edge runtimes,
 * ESM on an old Node) the step is skipped and the revision is simply unknown.
 *
 * Nothing here ever throws into the host application.
 */

/** Env vars consulted for the revision, in precedence order. */
export const GIT_REVISION_ENV_VARS: readonly string[] = [
  "MORSE_GIT_REVISION",
  "GITHUB_SHA",
  "CI_COMMIT_SHA",
  "RAILWAY_GIT_COMMIT_SHA",
  "VERCEL_GIT_COMMIT_SHA",
  "RENDER_GIT_COMMIT",
  "SOURCE_VERSION",
];

/** The server strips then truncates to this; matching it avoids sending bytes it will drop. */
const MAX_REVISION_LENGTH = 40;
/** Matches the server's `Trace.service_version` column cap. */
const MAX_SERVICE_VERSION_LENGTH = 128;
/** `git rev-parse HEAD` is local and instant; anything slower is a hung filesystem. */
const GIT_TIMEOUT_MS = 500;

function readEnv(name: string): string | undefined {
  try {
    if (typeof process !== "undefined" && process.env) {
      const v = process.env[name];
      if (typeof v === "string") return v;
    }
  } catch {
    // Some sandboxes make `process.env` access throw.
  }
  return undefined;
}

function cleanRevision(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().slice(0, MAX_REVISION_LENGTH);
  return v.length > 0 ? v : undefined;
}

/** The revision named by the environment, or undefined. Re-read on every call (cheap). */
export function revisionFromEnv(): string | undefined {
  for (const name of GIT_REVISION_ENV_VARS) {
    const v = cleanRevision(readEnv(name));
    if (v !== undefined) return v;
  }
  return undefined;
}

type ChildProcessLike = {
  execFileSync(
    file: string,
    args: readonly string[],
    options: Record<string, unknown>,
  ): string | Uint8Array;
};

function defaultLoadChildProcess(): ChildProcessLike | null {
  try {
    if (typeof process === "undefined" || !process.versions?.node) return null;
    try {
      const getBuiltin = (process as unknown as { getBuiltinModule?: (m: string) => unknown })
        .getBuiltinModule;
      if (typeof getBuiltin === "function") {
        const mod = getBuiltin.call(process, "node:child_process") as ChildProcessLike | undefined;
        if (mod && typeof mod.execFileSync === "function") return mod;
      }
    } catch {
      // Fall through to the require path.
    }
    // Run-time-eval'd so no bundler sees a `require("child_process")` literal.
    const dynamicRequire = Function("m", "return require(m)") as (m: string) => unknown;
    const mod = dynamicRequire("node:child_process") as ChildProcessLike | undefined;
    if (mod && typeof mod.execFileSync === "function") return mod;
  } catch {
    // child_process unavailable (browser, edge, ESM on old Node) — skip the step.
  }
  return null;
}

let loadChildProcess: () => ChildProcessLike | null = defaultLoadChildProcess;

/** `undefined` = not tried yet; `null` = tried, nothing found. Cached for the process. */
let gitCache: string | null | undefined;

function revisionFromGit(): string | undefined {
  if (gitCache !== undefined) return gitCache ?? undefined;
  let found: string | null = null;
  try {
    const cp = loadChildProcess();
    if (cp !== null) {
      const out = cp.execFileSync("git", ["rev-parse", "HEAD"], {
        timeout: GIT_TIMEOUT_MS,
        // stdin and stderr ignored: git must never prompt or write noise into the host's terminal.
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
        windowsHide: true,
      });
      const text = typeof out === "string" ? out : new TextDecoder().decode(out);
      const sha = cleanRevision(text);
      // Only a real object id; a wrapper script printing a banner must not become the revision.
      if (sha !== undefined && /^[0-9a-f]{7,64}$/i.test(sha)) found = sha;
    }
  } catch {
    // Not a git checkout, git not installed, timed out — all mean "unknown".
  }
  gitCache = found;
  return found ?? undefined;
}

/**
 * Parse `OTEL_RESOURCE_ATTRIBUTES` (`k1=v1,k2=v2`, values percent-encoded per the
 * OTel spec). Malformed pairs are skipped; a value that is not valid percent
 * encoding is kept verbatim rather than dropped.
 */
export function parseOtelResourceAttributes(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    if (key === "") continue;
    const rawValue = pair.slice(eq + 1).trim();
    let value = rawValue;
    try {
      value = decodeURIComponent(rawValue);
    } catch {
      // keep verbatim
    }
    out[key] = value;
  }
  return out;
}

/** `service.version` from `OTEL_RESOURCE_ATTRIBUTES`; there is deliberately no init option. */
export function serviceVersionFromEnv(): string | undefined {
  const v = parseOtelResourceAttributes(readEnv("OTEL_RESOURCE_ATTRIBUTES"))["service.version"];
  if (v === undefined) return undefined;
  const trimmed = v.trim().slice(0, MAX_SERVICE_VERSION_LENGTH);
  return trimmed.length > 0 ? trimmed : undefined;
}

/* ------------------------------------------------------------------------ */
/*  Process-level detected values, written by init()                         */
/* ------------------------------------------------------------------------ */

let detectedGitRevision: string | undefined;
let detectedServiceVersion: string | undefined;

/**
 * Resolve both values and remember them for the trace builders. Called from
 * `init()` only: the `git` subprocess (capped at 500ms, cached) must never run
 * on the per-trace hot path. Returns what it found. Never throws.
 */
export function detectDeploymentIdentity(): { gitRevision?: string; serviceVersion?: string } {
  try {
    detectedGitRevision = revisionFromEnv() ?? revisionFromGit();
    detectedServiceVersion = serviceVersionFromEnv();
  } catch {
    detectedGitRevision = undefined;
    detectedServiceVersion = undefined;
  }
  const out: { gitRevision?: string; serviceVersion?: string } = {};
  if (detectedGitRevision !== undefined) out.gitRevision = detectedGitRevision;
  if (detectedServiceVersion !== undefined) out.serviceVersion = detectedServiceVersion;
  return out;
}

export function getGitRevision(): string | undefined {
  return detectedGitRevision;
}

export function getServiceVersion(): string | undefined {
  return detectedServiceVersion;
}

/**
 * Test hook — forget the detected values but KEEP the cached git result, so a suite
 * of hundreds of `init()` calls spawns `git` once per test file, not once per test.
 */
export function _clearDetectedIdentityForTesting(): void {
  detectedGitRevision = undefined;
  detectedServiceVersion = undefined;
}

/** Test hook — forget detected values and the cached git result. */
export function _resetDeploymentIdentityForTesting(): void {
  detectedGitRevision = undefined;
  detectedServiceVersion = undefined;
  gitCache = undefined;
  loadChildProcess = defaultLoadChildProcess;
}

/** Test hook — substitute the `child_process` loader (`() => null` simulates edge/browser). */
export function _setChildProcessLoaderForTesting(loader: () => ChildProcessLike | null): void {
  loadChildProcess = loader;
  gitCache = undefined;
}
