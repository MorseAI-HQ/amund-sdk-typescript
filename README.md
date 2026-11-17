# Morse TypeScript SDK

[![npm](https://img.shields.io/npm/v/@morsehq-dev/sdk)](https://www.npmjs.com/package/@morsehq-dev/sdk)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

The TypeScript/Node SDK for [Morse](https://morseai.dev): verdict-first performance intelligence for production AI agents. Record what your agents did, what it cost, and whether it worked. Morse tells you which agents are getting better and which are just getting more expensive.

```bash
npm install @morsehq-dev/sdk   # Node 18.19+ or 20.6+
```

```ts
import * as morse from "@morsehq-dev/sdk";

morse.init({ apiKey: process.env.MORSE_API_KEY });
```

Adapters for the Anthropic SDK, Claude Agent SDK, OpenAI Agents, LangChain/LangGraph and the Vercel AI SDK. It also works with any OpenTelemetry setup and is safe to bundle in full-stack apps (Next.js, Remix, SvelteKit).

- **Full SDK guide:** [`apps/sdk/typescript/README.md`](apps/sdk/typescript/README.md)
- **Docs:** https://docs.morseai.dev
- **Changelog:** [`apps/sdk/typescript/CHANGELOG.md`](apps/sdk/typescript/CHANGELOG.md)
- **Security issues:** https://morseai.dev/security/disclosure (please don't open a public issue)

## License

[MIT](LICENSE)
