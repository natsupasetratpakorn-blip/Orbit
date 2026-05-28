import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createTimelineSnapshot,
  isAllowedExternalUrl,
  normalizeWorkspaceRoot,
  resolveInsideWorkspace
} from "../src/shared/workspace-security.js";

describe("workspace security helpers", () => {
  it("normalizes workspace roots to absolute paths", () => {
    expect(normalizeWorkspaceRoot(".")).toBe(resolve("."));
    expect(normalizeWorkspaceRoot("")).toBe("");
  });

  it("resolves relative paths inside the workspace", () => {
    const root = resolve("example-workspace");

    expect(resolveInsideWorkspace(root, "src/index.js")).toEqual({
      root,
      fullPath: join(root, "src", "index.js"),
      relativePath: join("src", "index.js")
    });
  });

  it("rejects traversal outside the workspace", () => {
    const root = resolve("example-workspace");

    expect(() => resolveInsideWorkspace(root, "../secret.txt")).toThrow(/outside the workspace/);
    expect(() => resolveInsideWorkspace(root, resolve("outside.txt"))).toThrow(/outside the workspace/);
  });

  it("allows only http and https external URLs", () => {
    expect(isAllowedExternalUrl("https://example.com")).toBe(true);
    expect(isAllowedExternalUrl("http://localhost:3000")).toBe(true);
    expect(isAllowedExternalUrl("file:///C:/Windows/System32/calc.exe")).toBe(false);
    expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedExternalUrl("not a url")).toBe(false);
  });

  it("stores small non-sensitive timeline snapshots", () => {
    expect(createTimelineSnapshot("src/index.js", "hello")).toEqual({
      prevContent: "hello",
      prevContentStatus: "stored",
      prevContentBytes: 5
    });
  });

  it("redacts sensitive timeline snapshots", () => {
    expect(createTimelineSnapshot(".env", "TOKEN=secret")).toEqual({
      prevContent: null,
      prevContentStatus: "redacted-sensitive-path"
    });
    expect(createTimelineSnapshot("keys/service.pem", "secret")).toEqual({
      prevContent: null,
      prevContentStatus: "redacted-sensitive-path"
    });
  });

  it("omits large timeline snapshots", () => {
    const snapshot = createTimelineSnapshot("big.txt", "a".repeat(256 * 1024 + 1));

    expect(snapshot.prevContent).toBeNull();
    expect(snapshot.prevContentStatus).toBe("omitted-large-file");
    expect(snapshot.prevContentBytes).toBe(256 * 1024 + 1);
  });
});
