import Anthropic from "@anthropic-ai/sdk";
import { runTraced } from "@amund/sdk";
import { wrapAnthropic } from "@amund/sdk/anthropic";
import { requireEnv, runDogfood } from "./_common.js";

async function main() {
  requireEnv("ANTHROPIC_API_KEY");
  const client = wrapAnthropic(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
  await runTraced({ agentName: "pub-e2e-ts-anthropic" }, async () => {
    const res = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5",
      max_tokens: 128,
      messages: [{ role: "user", content: "Name three reasons to adopt observability. Be terse." }],
    });
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    console.log(`  reply: ${text.slice(0, 100).replace(/\n/g, " ")}`);
    return null;
  });
  return { outcome: "completed" };
}

void runDogfood("pub-e2e-ts-anthropic", main);
