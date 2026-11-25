import OpenAI from "openai";
import { runTraced } from "@amundai/sdk";
import { wrapOpenAI } from "@amundai/sdk/openai";
import { requireEnv, runDogfood } from "./_common.js";

async function main() {
  requireEnv("OPENAI_API_KEY");
  const client = wrapOpenAI(new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));
  await runTraced({ agentName: "pub-e2e-ts-openai" }, async () => {
    const res = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [{ role: "user", content: "Name three reasons to adopt observability. Be terse." }],
    });
    console.log(
      `  reply: ${String(res.choices[0]?.message?.content).slice(0, 100).replace(/\n/g, " ")}`,
    );
    return null;
  });
  return { outcome: "completed" };
}

void runDogfood("pub-e2e-ts-openai", main);
