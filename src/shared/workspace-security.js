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

// Hostnames that resolve to the local machine or a local-only namespace. Even
// though they're valid http(s), fetching them server-side is the classic SSRF
// pivot (admin panels, dev servers, mDNS, corp intranet).
const BLOCKED_HOSTNAMES = new Set(["localhost", ""]);
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".intranet", ".corp"];

function ipv4ToInt(host) {
  const m = String(host).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return null;
  return ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
}

// True for any IPv4/IPv6 literal that points at the local host or a private /
// reserved network (loopback, RFC1918, link-local incl. the 169.254.169.254
// cloud-metadata endpoint, CGNAT, ULA). Hostnames that aren't IP literals
// return false here — resolve them first (see web-tools) to catch rebinding.
export function isPrivateAddress(host) {
  const h = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;

  if (h.includes(":")) {
    // IPv6
    if (h === "::1" || h === "::") return true;              // loopback / unspecified
    if (h.startsWith("fe80")) return true;                   // link-local
    if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique-local fc00::/7
    const tail = h.split(":").pop();                         // ::ffff:a.b.c.d mapped form
    if (tail && tail.includes(".")) return isPrivateAddress(tail);
    return false;
  }

  const n = ipv4ToInt(h);
  if (n === null) return false; // not an IP literal
  const inRange = (base, bits) => (n >>> (32 - bits)) === (ipv4ToInt(base) >>> (32 - bits));
  return (
    inRange("0.0.0.0", 8) ||      // "this" network
    inRange("10.0.0.0", 8) ||     // private
    inRange("100.64.0.0", 10) ||  // CGNAT
    inRange("127.0.0.0", 8) ||    // loopback
    inRange("169.254.0.0", 16) || // link-local (cloud metadata)
    inRange("172.16.0.0", 12) ||  // private
    inRange("192.168.0.0", 16)    // private
  );
}

// Looser check for URLs handed to the user's OWN browser via the OS
// (shell.openExternal). Opening http://localhost:3000 — a local dev server — is
// legitimate and user-visible, so this validates only the scheme. Do NOT use it
// to gate silent server-side fetches; use isAllowedExternalUrl for those.
export function isExternalHttpUrl(value) {
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

// Strict check for silent server-side fetches (web_search / read_webpage /
// deep_research). Beyond the scheme, it rejects localhost and private/reserved
// IP literals so a prompt-injected URL can't pivot into the local host or LAN.
export function isAllowedExternalUrl(value) {
  if (!isExternalHttpUrl(value)) {
    return false;
  }
  const parsed = new URL(value);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.has(host)) return false;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  if (isPrivateAddress(host)) return false;
  return true;
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
