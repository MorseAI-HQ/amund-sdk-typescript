# Amund TypeScript SDK

[![npm](https://img.shields.io/npm/v/@amundai/sdk)](https://www.npmjs.com/package/@amundai/sdk)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

The TypeScript/Node SDK for [Amund](https://amundai.com) (formerly Morse): verdict-first performance intelligence for production AI agents. Record what your agents did, what it cost, and whether it worked. Amund tells you which agents are getting better and which are just getting more expensive.

```bash
npm install @amundai/sdk   # Node 18.19+ or 20.6+
```

```ts
import * as morse from "@amundai/sdk";

morse.init({ apiKey: process.env.AMUND_API_KEY });
```

Adapters for the Anthropic SDK, Claude Agent SDK, OpenAI Agents, LangChain/LangGraph and the Vercel AI SDK. It also works with any OpenTelemetry setup and is safe to bundle in full-stack apps (Next.js, Remix, SvelteKit).

**Coming from `@morsehq-dev/sdk`?** That package still works: from the first `@amundai/sdk` release it is a thin
compatibility shim that re-exports `@amundai/sdk` and prints a one-time deprecation notice.
Switch the dependency and your import paths to `@amundai/sdk`; nothing else changes.
`MORSE_*` environment variables are still read (`AMUND_*` wins when both are set).

- **Full SDK guide:** [`apps/sdk/typescript/README.md`](apps/sdk/typescript/README.md)
- **Docs:** https://docs.amundai.com
- **Changelog:** [`apps/sdk/typescript/CHANGELOG.md`](apps/sdk/typescript/CHANGELOG.md)
- **Security issues:** https://amundai.com/security/disclosure (please don't open a public issue)

## License

[MIT](LICENSE)
