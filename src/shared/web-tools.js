import { lookup as dnsLookup } from "node:dns/promises";

import { isAllowedExternalUrl, isPrivateAddress } from "./workspace-security.js";

const ENTITY_MAP = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " "
};

export function decodeHtmlEntities(value) {
  return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const key = String(entity).toLowerCase();
    if (key.startsWith("#x")) {
      const code = parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (key.startsWith("#")) {
      const code = parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return Object.prototype.hasOwnProperty.call(ENTITY_MAP, key) ? ENTITY_MAP[key] : match;
  });
}

export function compactWhitespace(value) {
  return String(value || "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripHtmlToText(html) {
  return decodeHtmlEntities(String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<\/?(?:h[1-6]|p|div|section|article|main|header|footer|aside|nav|li|ul|ol|table|tr|blockquote|pre)\b[^>]*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " "));
}

export function extractReadablePageText(html, { maxChars = 20000 } = {}) {
  const source = String(html || "");
  const titleMatch = source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = compactWhitespace(stripHtmlToText(titleMatch?.[1] || ""));

  let body = source.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] || source;
  const main = body.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  if (main) body = main;

  const text = compactWhitespace(stripHtmlToText(body));
  const truncated = text.length > maxChars;
  return {
    title,
    text: truncated ? truncateAtWord(text, maxChars) : text,
    truncated
  };
}

// Cut to at most `maxChars`, backing up to the last whitespace so we don't slice
// a word in half. Falls back to a hard cut if there's no nearby break.
export function truncateAtWord(value, maxChars) {
  const s = String(value || "");
  if (s.length <= maxChars) return s.trim();
  const slice = s.slice(0, maxChars);
  const lastBreak = slice.search(/\s\S*$/);
  return (lastBreak > maxChars * 0.6 ? slice.slice(0, lastBreak) : slice).trim();
}

export function sourceFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

export function normalizeSearchResults(results, { limit = 6 } = {}) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(results) ? results : []) {
    const title = compactWhitespace(decodeHtmlEntities(item?.title || ""));
    const url = String(item?.url || "").trim();
    const snippet = compactWhitespace(decodeHtmlEntities(item?.snippet || ""));
    if (!title || !url || !isAllowedExternalUrl(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ title, url, snippet, source: sourceFromUrl(url) });
    if (out.length >= limit) break;
  }
  return out;
}

export function decodeDuckDuckGoResultUrl(value) {
  const raw = decodeHtmlEntities(String(value || "").trim());
  try {
    const parsed = new URL(raw, "https://duckduckgo.com");
    const redirected = parsed.searchParams.get("uddg");
    return redirected ? decodeURIComponent(redirected) : parsed.href;
  } catch {
    return raw;
  }
}

export function parseDuckDuckGoHtml(html) {
  const source = String(html || "");
  const results = [];
  const blockRe = /<div[^>]+class="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]+class="[^"]*\bresult\b|<\/body>|$)/gi;
  let blockMatch;
  while ((blockMatch = blockRe.exec(source)) !== null) {
    const block = blockMatch[1];
    const linkMatch = block.match(/<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const snippetMatch = block.match(/<a[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<div[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    results.push({
      title: stripHtmlToText(linkMatch[2]),
      url: decodeDuckDuckGoResultUrl(linkMatch[1]),
      snippet: snippetMatch ? stripHtmlToText(snippetMatch[1]) : ""
    });
  }
  return normalizeSearchResults(results);
}

const WEB_TOOL_HEADERS = {
  "user-agent": "Orbit/0.1 (+https://orbit.local) AppleWebKit/537.36",
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5"
};

async function defaultLookupHost(host) {
  const records = await dnsLookup(host, { all: true });
  return records.map((r) => r.address);
}

// Guard an outbound fetch of a model/user-controlled URL. Rejects non-http(s),
// localhost/private literals (sync), and — crucially — hostnames that *resolve*
// to a private address (DNS rebinding to localhost, the LAN, or the cloud
// metadata endpoint). Note: a small TOCTOU window remains between resolve and
// fetch; this blocks the realistic prompt-injection→SSRF pivot, not a
// motivated attacker who controls authoritative DNS timing.
async function assertSafeFetchTarget(target, lookupHost = defaultLookupHost) {
  let parsed;
  try {
    parsed = new URL(String(target || ""));
  } catch {
    throw new Error("Only http:// and https:// pages can be read.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http:// and https:// pages can be read.");
  }
  if (!isAllowedExternalUrl(target)) {
    throw new Error("Refusing to fetch a local or private-network address.");
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  let addresses;
  try {
    addresses = await lookupHost(host);
  } catch {
    throw new Error(`Could not resolve host: ${host}`);
  }
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some((addr) => isPrivateAddress(addr))) {
    throw new Error("Refusing to fetch a local or private-network address.");
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function searchDuckDuckGoInstant(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const res = await fetchWithTimeout(url, { headers: { "user-agent": WEB_TOOL_HEADERS["user-agent"], "accept": "application/json" } });
  if (!res.ok) return [];
  const data = await res.json();
  const flat = [];
  const visit = (items) => {
    for (const item of Array.isArray(items) ? items : []) {
      if (item?.FirstURL && item?.Text) {
        flat.push({ title: item.Text.split(" - ")[0] || item.Text, url: item.FirstURL, snippet: item.Text });
      }
      if (Array.isArray(item?.Topics)) visit(item.Topics);
    }
  };
  visit(data?.RelatedTopics);
  if (data?.AbstractURL && data?.AbstractText) {
    flat.unshift({ title: data.Heading || query, url: data.AbstractURL, snippet: data.AbstractText });
  }
  return normalizeSearchResults(flat);
}

export async function performWebSearch(query) {
  const q = String(query || "").trim();
  if (!q) return { ok: false, error: "No search query provided.", results: [] };

  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  try {
    const res = await fetchWithTimeout(url, { headers: WEB_TOOL_HEADERS });
    const html = await res.text();
    let results = res.ok ? parseDuckDuckGoHtml(html) : [];
    // The HTML scraper is best-effort: DDG rotates its markup and rate-limits
    // scrapers, so a "success" with 0–1 results usually means the parse missed,
    // not that the web is empty. Fall back to the Instant Answer JSON API and
    // keep whichever set is richer.
    if (results.length < 2) {
      const instant = await searchDuckDuckGoInstant(q);
      if (instant.length > results.length) results = instant;
    }
    return { ok: true, query: q, results };
  } catch (err) {
    try {
      const results = await searchDuckDuckGoInstant(q);
      if (results.length) return { ok: true, query: q, results };
    } catch {}
    return { ok: false, error: err?.name === "AbortError" ? "Search timed out." : (err?.message || String(err)), results: [] };
  }
}

export async function performReadWebpage(url, { lookupHost = defaultLookupHost } = {}) {
  const target = String(url || "").trim();
  try {
    await assertSafeFetchTarget(target, lookupHost);
  } catch (err) {
    return { ok: false, error: err?.message || "Unsafe URL." };
  }
  try {
    const res = await fetchWithTimeout(target, { headers: WEB_TOOL_HEADERS });
    const contentType = String(res.headers.get("content-type") || "").toLowerCase();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${res.statusText}`.trim() };
    if (contentType && !/(text\/html|application\/xhtml\+xml|text\/plain|application\/xml|text\/xml)/.test(contentType)) {
      return { ok: false, error: `Unsupported content type: ${contentType}` };
    }
    const raw = await res.text();
    const page = extractReadablePageText(raw);
    return { ok: true, url: target, title: page.title || target, text: page.text, truncated: page.truncated };
  } catch (err) {
    return { ok: false, error: err?.name === "AbortError" ? "Page read timed out." : (err?.message || String(err)) };
  }
}

export async function performDeepResearch(query, { search = performWebSearch, readPage = performReadWebpage, limit = 3, maxPageChars = 12000 } = {}) {
  const q = String(query || "").trim();
  if (!q) return { ok: false, error: "No research query provided.", query: "", results: [], report: "" };

  const searchRes = await search(q);
  if (!searchRes?.ok) {
    return {
      ok: false,
      error: searchRes?.error || "Search failed.",
      query: q,
      results: [],
      report: ""
    };
  }

  const results = (Array.isArray(searchRes.results) ? searchRes.results : []).slice(0, limit);
  if (results.length === 0) {
    return {
      ok: true,
      query: q,
      results: [],
      report: `# Deep research report for "${q}"\n\nNo web results found.`
    };
  }

  const pages = await Promise.all(results.map(async (result) => {
    try {
      const page = await readPage(result.url);
      return { result, page };
    } catch (err) {
      return { result, page: { ok: false, error: err?.message || String(err) } };
    }
  }));

  const reportParts = [`# Deep research report for "${q}"`, ""];
  pages.forEach(({ result, page }, idx) => {
    reportParts.push(`## ${idx + 1}. ${result.title}`);
    reportParts.push(`URL: ${result.url}`);
    if (result.source) reportParts.push(`Source: ${result.source}`);
    if (result.snippet) reportParts.push(`Search snippet: ${result.snippet}`);
    reportParts.push("");

    if (page?.ok) {
      const text = String(page.text || "(no readable text)");
      const capped = text.length > maxPageChars
        ? `${text.slice(0, maxPageChars).trim()}\n\n[Page excerpt truncated for context budget]`
        : text;
      reportParts.push(`Title: ${page.title || result.title}`);
      reportParts.push("");
      reportParts.push(capped);
      if (page.truncated) reportParts.push("\n[Original page text was truncated during extraction]");
    } else {
      reportParts.push(`[Could not read page: ${page?.error || "unknown error"}]`);
    }
    reportParts.push("");
  });

  return {
    ok: true,
    query: q,
    results,
    report: compactWhitespace(reportParts.join("\n"))
  };
}
