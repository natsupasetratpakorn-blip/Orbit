import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createTimelineSnapshot,
  isAllowedExternalUrl,
  isExternalHttpUrl,
  isPrivateAddress,
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

  it("allows only public http and https external URLs", () => {
    expect(isAllowedExternalUrl("https://example.com")).toBe(true);
    expect(isAllowedExternalUrl("http://93.184.216.34/page")).toBe(true);
    expect(isAllowedExternalUrl("file:///C:/Windows/System32/calc.exe")).toBe(false);
    expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedExternalUrl("not a url")).toBe(false);
  });

  it("blocks localhost, private, and link-local URLs (SSRF guard)", () => {
    expect(isAllowedExternalUrl("http://localhost:3000")).toBe(false);
    expect(isAllowedExternalUrl("http://dev.local/admin")).toBe(false);
    expect(isAllowedExternalUrl("http://127.0.0.1:8080")).toBe(false);
    expect(isAllowedExternalUrl("http://10.0.0.5")).toBe(false);
    expect(isAllowedExternalUrl("http://192.168.1.1")).toBe(false);
    expect(isAllowedExternalUrl("http://172.16.4.2")).toBe(false);
    expect(isAllowedExternalUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isAllowedExternalUrl("http://[::1]/")).toBe(false);
  });

  it("still allows localhost for the user's own browser (open-external path)", () => {
    // isExternalHttpUrl gates shell.openExternal, where opening a local dev
    // server is legitimate — only the strict fetch guard blocks localhost.
    expect(isExternalHttpUrl("http://localhost:3000")).toBe(true);
    expect(isExternalHttpUrl("https://example.com")).toBe(true);
    expect(isExternalHttpUrl("file:///C:/secrets.txt")).toBe(false);
    expect(isExternalHttpUrl("javascript:alert(1)")).toBe(false);
  });

  it("classifies private and reserved IP literals", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("10.255.255.255")).toBe(true);
    expect(isPrivateAddress("172.16.0.1")).toBe(true);
    expect(isPrivateAddress("172.32.0.1")).toBe(false); // just outside 172.16/12
    expect(isPrivateAddress("192.168.0.1")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("100.64.0.1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("2607:f8b0::1")).toBe(false);
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
