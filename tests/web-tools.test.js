import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { decodeHtmlEntities, extractReadablePageText, normalizeSearchResults, performWebSearch, performReadWebpage, performDeepResearch, truncateAtWord } from "../src/shared/web-tools.js";

describe("web tool helpers", () => {
  it("extracts useful page text without scripts or styles", () => {
    const html = `
      <html>
        <head><title>Orbit &amp; Voyager</title><style>.x{color:red}</style></head>
        <body>
          <script>window.secret = true</script>
          <main>
            <h1>Voyager Mission</h1>
            <p>Humanity&apos;s long-range messenger.</p>
          </main>
        </body>
      </html>
    `;

    expect(extractReadablePageText(html)).toEqual({
      title: "Orbit & Voyager",
      text: "Voyager Mission\nHumanity's long-range messenger.",
      truncated: false
    });
  });

  it("normalizes search results and drops unsafe URLs", () => {
    const results = normalizeSearchResults([
      { title: " A result ", url: "https://example.com/page", snippet: " First hit " },
      { title: "Bad", url: "javascript:alert(1)", snippet: "nope" },
      { title: "", url: "https://example.com/empty", snippet: "" }
    ]);

    expect(results).toEqual([
      {
        title: "A result",
        url: "https://example.com/page",
        snippet: "First hit",
        source: "example.com"
      }
    ]);
  });

  it("truncates at a word boundary instead of mid-word", () => {
    const text = "the quick brown fox jumps over the lazy dog";
    const cut = truncateAtWord(text, 18); // mid-"brown"
    expect(cut).toBe("the quick brown");
    expect(text.startsWith(cut)).toBe(true);
    expect(truncateAtWord("short", 50)).toBe("short");
  });

  it("decodes common named and numeric HTML entities", () => {
    expect(decodeHtmlEntities("A&nbsp;B &amp; C &#39;D&#39; &#x2F;")).toBe("A B & C 'D' /");
  });
});

describe("performWebSearch & performReadWebpage (mocked network)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("performWebSearch parses DuckDuckGo HTML", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => `
        <div class="result">
          <a class="result__a" href="https://example.com/f1">F1 2024 Winner</a>
          <a class="result__snippet">Max won again.</a>
        </div>
        <div class="result">
          <a class="result__a" href="https://example.com/f1-standings">F1 2024 Standings</a>
          <a class="result__snippet">Full championship table.</a>
        </div>
      `
    });

    const res = await performWebSearch("f1 winner");
    expect(res.ok).toBe(true);
    expect(res.results).toHaveLength(2);
    expect(res.results[0].title).toBe("F1 2024 Winner");
    expect(res.results[0].url).toBe("https://example.com/f1");
    expect(res.results[0].snippet).toBe("Max won again.");
  });

  it("performWebSearch falls back to the Instant API when the scraper yields too few results", async () => {
    // HTML parse succeeds but returns only one weak result …
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => `
        <div class="result">
          <a class="result__a" href="https://example.com/thin">Thin result</a>
        </div>
      `
    });
    // … so we fall back to the Instant API, which returns a richer set.
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        RelatedTopics: [
          { FirstURL: "https://example.com/a", Text: "Alpha - first" },
          { FirstURL: "https://example.com/b", Text: "Beta - second" }
        ]
      })
    });

    const res = await performWebSearch("thin query");
    expect(res.ok).toBe(true);
    expect(res.results.map((r) => r.url)).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("performWebSearch falls back to Instant API on HTML timeout/fail", async () => {
    // First fetch (HTML) fails
    global.fetch.mockRejectedValueOnce(new Error("Network Error"));
    // Second fetch (Instant) succeeds
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        Heading: "Fallback API",
        AbstractURL: "https://example.com/api",
        AbstractText: "This is from the Instant API."
      })
    });

    const res = await performWebSearch("api fallback");
    expect(res.ok).toBe(true);
    expect(res.results[0].title).toBe("Fallback API");
    expect(res.results[0].url).toBe("https://example.com/api");
  });

  it("performReadWebpage extracts text from a standard HTML page", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/html" }),
      text: async () => "<html><title>Test Page</title><body><main>Content goes here</main></body></html>"
    });

    const res = await performReadWebpage("https://example.com/article", {
      lookupHost: async () => ["93.184.216.34"]
    });
    expect(res.ok).toBe(true);
    expect(res.title).toBe("Test Page");
    expect(res.text).toBe("Content goes here");
  });

  it("performReadWebpage handles blocked/bad URLs", async () => {
    const res = await performReadWebpage("file:///C:/secrets.txt");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Only http/i);
  });

  it("performReadWebpage refuses localhost/private literals before fetching (SSRF)", async () => {
    const res = await performReadWebpage("http://169.254.169.254/latest/meta-data/");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/private|local/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("performReadWebpage refuses hostnames that resolve to a private IP (DNS rebinding)", async () => {
    const res = await performReadWebpage("https://rebind.evil.test/", {
      lookupHost: async () => ["127.0.0.1"]
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/private|local/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("performDeepResearch", () => {
  it("searches and reads the top three results into one report", async () => {
    const search = vi.fn(async () => ({
      ok: true,
      results: [
        { title: "One", url: "https://example.com/one", snippet: "First snippet", source: "example.com" },
        { title: "Two", url: "https://example.com/two", snippet: "Second snippet", source: "example.com" },
        { title: "Three", url: "https://example.com/three", snippet: "Third snippet", source: "example.com" },
        { title: "Four", url: "https://example.com/four", snippet: "Fourth snippet", source: "example.com" }
      ]
    }));
    const readPage = vi.fn(async (url) => ({
      ok: true,
      url,
      title: `Read ${url}`,
      text: `Readable text from ${url}`,
      truncated: false
    }));

    const res = await performDeepResearch("orbit electron", { search, readPage });

    expect(res.ok).toBe(true);
    expect(readPage).toHaveBeenCalledTimes(3);
    expect(readPage).toHaveBeenNthCalledWith(1, "https://example.com/one");
    expect(res.report).toContain('Deep research report for "orbit electron"');
    expect(res.report).toContain("## 1. One");
    expect(res.report).toContain("Readable text from https://example.com/three");
    expect(res.report).not.toContain("https://example.com/four");
  });
});
