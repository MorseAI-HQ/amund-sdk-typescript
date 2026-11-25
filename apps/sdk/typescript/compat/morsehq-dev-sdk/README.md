# @morsehq-dev/sdk (deprecated: use `@amund/sdk`)

Morse is now [Amund](https://amundai.com). The SDK is published as
[`@amund/sdk`](https://www.npmjs.com/package/@amund/sdk); this package is a
compatibility shim so existing installs keep working.

```bash
npm uninstall @morsehq-dev/sdk
npm install @amund/sdk
```

```diff
- import * as morse from "@morsehq-dev/sdk";
- import { wrapAnthropic } from "@morsehq-dev/sdk/anthropic";
+ import * as morse from "@amund/sdk";
+ import { wrapAnthropic } from "@amund/sdk/anthropic";
```

Nothing else changes: same API, same subpaths, same `mhq_` keys, same endpoint.
`MORSE_*` environment variables keep working; `AMUND_*` takes precedence when both
are set.

## How the shim works

- It depends on exactly the same version of `@amund/sdk` and has the same
  `exports` map (every subpath; ESM, CommonJS, types and `browser` conditions).
- Every entry point is a one-line re-export of the matching `@amund/sdk` entry
  point, so both names return the same module instances: one SDK, one transport,
  even if your code imports from both during a migration.
- The first import prints one deprecation notice per process. It is not printed
  under `NODE_NO_WARNINGS=1`, `node --no-deprecation`, or when the SDK is disabled
  (`AMUND_DISABLED` / `MORSE_DISABLED`).

Docs: https://docs.amundai.com
