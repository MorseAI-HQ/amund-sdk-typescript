import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, lstat, readlink, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);

test("updated protobuf preserves OpenTelemetry trace export and message round trips", async () => {
  const {
    BasicTracerProvider,
    InMemorySpanExporter,
    SimpleSpanProcessor,
  } = require("@opentelemetry/sdk-trace-base");
  const { ProtobufTraceSerializer } = require("@opentelemetry/otlp-transformer");
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  try {
    const span = provider.getTracer("morse-security-test").startSpan("agent.run");
    span.setAttribute("agent.name", "regression");
    span.end();
    await provider.forceFlush();
    assert.ok(ProtobufTraceSerializer.serializeRequest(exporter.getFinishedSpans()).length > 0);
    const protobuf = require("protobufjs");
    const type = protobuf
      .parse('syntax = "proto3"; message Run { string agent = 1; repeated string labels = 2; }')
      .root.lookupType("Run");
    const run = { agent: "regression", labels: ["successful", "instrumented"] };
    assert.deepEqual(type.toObject(type.decode(type.encode(run).finish())), run);
  } finally {
    await provider.shutdown();
  }
});

test("DOMPurify neutralizes descendants detached by after-sanitize hooks", () => {
  // GHSA-p98j-92pf-mc4p: inspect the retained node, not only the sanitized output.
  const { JSDOM } = require("jsdom");
  for (const hook of ["afterSanitizeElements", "afterSanitizeAttributes"]) {
    const dom = new JSDOM("<!doctype html><body></body>");
    try {
      const purifier = require("dompurify")(dom.window);
      const root = dom.window.document.createElement("div");
      root.innerHTML = '<section id="detach"><img src="invalid" onerror="void 0"></section>';
      dom.window.document.body.append(root);
      const image = root.querySelector("img");
      purifier.addHook(hook, (node) => {
        if (node.id === "detach") node.remove();
      });
      purifier.sanitize(root, { IN_PLACE: true });
      assert.equal(root.querySelector("#detach"), null);
      assert.equal(image.hasAttribute("onerror"), false, hook);
    } finally {
      dom.window.close();
    }
  }
});

test("Mermaid parses a docs flowchart under strict security", async () => {
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
  const parsed = await mermaid.parse("flowchart TD\n  A --> B");
  assert.equal(parsed.diagramType, "flowchart-v2");
});

test("selector parser preserves a consumer class transformation", () => {
  const parser = require("postcss-selector-parser");
  const result = parser((root) =>
    root.walkClasses((node) => {
      node.value = `docs-${node.value}`;
    }),
  ).processSync(".panel > a:hover");
  assert.equal(result, ".docs-panel > a:hover");
});

test("PostHog compression dependency preserves ZIP and gzip round trips", () => {
  const posthogRequire = createRequire(require.resolve("posthog-js"));
  const compression = posthogRequire("fflate");
  const payload = compression.strToU8("Morse telemetry regression");
  assert.deepEqual(compression.gunzipSync(compression.gzipSync(payload)), payload);
  const archive = compression.zipSync({ "telemetry.txt": payload });
  assert.deepEqual(compression.unzipSync(archive)["telemetry.txt"], payload);
});

test("ESLint YAML dependency handles configuration and bounds empty merges", () => {
  const eslintRequire = createRequire(require.resolve("@eslint/eslintrc"));
  const yaml = eslintRequire("js-yaml");
  assert.deepEqual(yaml.load("rules:\n  strict: true\n"), { rules: { strict: true } });
  assert.throws(
    () =>
      yaml.load("base: &base {}\nmerged: {<<: [*base, *base, *base]}", {
        schema: yaml.YAML11_SCHEMA,
        maxTotalMergeKeys: 1,
      }),
    /maxTotalMergeKeys/,
  );
});

test("AI provider utilities retain valid and invalid JSON handling", async () => {
  const utils = require("@ai-sdk/provider-utils");
  const valid = await utils.safeParseJSON({ text: '{"answer":"verified"}' });
  assert.equal(valid.success, true);
  assert.deepEqual(valid.value, { answer: "verified" });
  assert.equal((await utils.safeParseJSON({ text: "{invalid}" })).success, false);
});

test("humanfs copies symlinks without copying external file contents", async () => {
  const { hfs } = await import("@humanfs/node");
  const scratch = await mkdtemp(join(tmpdir(), "morse-copy-regression-"));
  try {
    const source = join(scratch, "source");
    const destination = join(scratch, "destination");
    const external = join(scratch, "external.txt");
    await mkdir(source);
    await writeFile(external, "outside source tree");
    await symlink(external, join(source, "external-link"));
    await hfs.copyAll(source, destination);
    const copied = join(destination, "external-link");
    assert.equal((await lstat(copied)).isSymbolicLink(), true);
    assert.equal(await readlink(copied), external);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
