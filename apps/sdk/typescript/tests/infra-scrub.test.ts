/**
 * INFRACAP-05 — inline SQL literal scrubber (TypeScript twin of Python's
 * `scrub_sql`, same cases).
 */

import { describe, expect, it } from "vitest";

import { safeStatement, scrubDbAttributes, scrubSql } from "../src/_internal/infra-shared";

describe("scrubSql", () => {
  it.each([
    [
      "SELECT * FROM users WHERE email = 'a@b.com' AND id = 42",
      "SELECT * FROM users WHERE email = ? AND id = ?",
    ],
    ["SELECT * FROM t WHERE a = %s AND b = ?", "SELECT * FROM t WHERE a = %s AND b = ?"],
    ["SELECT $1, :name FROM t1", "SELECT $1, :name FROM t1"],
    ["INSERT INTO t VALUES ('it''s secret', 3.14, 0xDEADBEEF)", "INSERT INTO t VALUES (?, ?, ?)"],
    ["SELECT $tag$secret body$tag$", "SELECT ?"],
    ["SELECT $$secret body$$", "SELECT ?"],
    ["SELECT 1 -- ssn 123-45-6789\n, 2", "SELECT ? \n, ?"],
    ["SELECT /* tok_abc */ 1", "SELECT  ?"],
    ["SELECT E'a\\'b' , 'c'", "SELECT ? , ?"],
    ["WHERE x IN (1, 2, 3) LIMIT 10", "WHERE x IN (?, ?, ?) LIMIT ?"],
  ])("%s", (raw, expected) => {
    // @spec: INFRACAP-05
    expect(scrubSql(raw)).toBe(expected);
  });

  it("an unterminated quote drops the tail rather than leaking it", () => {
    // @spec: INFRACAP-05
    expect(scrubSql("SELECT 'oops secret-value")).not.toContain("secret-value");
  });

  it("is idempotent", () => {
    // @spec: INFRACAP-05
    const once = scrubSql("SELECT 'x', 5 FROM t WHERE a = $1");
    expect(scrubSql(once)).toBe(once);
  });
});

describe("safeStatement / scrubDbAttributes", () => {
  it("truncates long statements after scrubbing", () => {
    // @spec: INFRACAP-05
    const out = safeStatement("SELECT " + "col, ".repeat(2000));
    expect(out!.endsWith("…[truncated]")).toBe(true);
    expect(out!.length).toBeLessThan(2100);
  });

  it("scrubs statement attributes and drops parameter attributes in place", () => {
    // @spec: INFRACAP-05
    const attrs: Record<string, unknown> = {
      "db.query.text": "SELECT * FROM u WHERE email = 'canary@example.com'",
      "db.statement": "UPDATE u SET n = 7",
      "db.query.parameter.0": "canary@example.com",
      "db.operation.parameter.1": "canary",
      "db.system.name": "postgresql",
    };
    scrubDbAttributes(attrs);
    expect(attrs).toEqual({
      "db.query.text": "SELECT * FROM u WHERE email = ?",
      "db.statement": "UPDATE u SET n = ?",
      "db.system.name": "postgresql",
    });
  });
});
