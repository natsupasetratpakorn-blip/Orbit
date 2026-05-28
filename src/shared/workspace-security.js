import { isAbsolute, relative, resolve } from "node:path";

const MAX_TIMELINE_CONTENT_BYTES = 256 * 1024;
const SENSITIVE_PATH_SEGMENTS = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519"
]);

export function normalizeWorkspaceRoot(workspacePath) {
  if (typeof workspacePath !== "string" || !workspacePath.trim()) {
    return "";
  }
  return resolve(workspacePath);
}

export function resolveInsideWorkspace(workspacePath, requestedPath) {
  const root = normalizeWorkspaceRoot(workspacePath);
  if (!root) {
    throw new Error("No workspace is open.");
  }
  if (typeof requestedPath !== "string" || !requestedPath.trim()) {
    throw new Error("Missing or invalid path.");
  }
  if (isAbsolute(requestedPath)) {
    throw new Error(`Access denied: path "${requestedPath}" resolves outside the workspace.`);
  }

  const fullPath = resolve(root, requestedPath);
  const rel = relative(root, fullPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Access denied: path "${requestedPath}" resolves outside the workspace.`);
  }

  return {
    root,
    fullPath,
    relativePath: rel || "."
  };
}

export function isAllowedExternalUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function createTimelineSnapshot(relativePath, content) {
  if (typeof content !== "string") {
    return { prevContent: null, prevContentStatus: "unavailable" };
  }

  const segments = String(relativePath || "")
    .split(/[\\/]+/)
    .map((part) => part.toLowerCase());
  if (segments.some((part) => SENSITIVE_PATH_SEGMENTS.has(part) || part.endsWith(".pem") || part.endsWith(".key"))) {
    return { prevContent: null, prevContentStatus: "redacted-sensitive-path" };
  }

  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength > MAX_TIMELINE_CONTENT_BYTES) {
    return { prevContent: null, prevContentStatus: "omitted-large-file", prevContentBytes: byteLength };
  }

  return { prevContent: content, prevContentStatus: "stored", prevContentBytes: byteLength };
}
