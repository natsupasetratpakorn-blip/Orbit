import { describe, expect, it } from "vitest";
import { parseAIResponse, renderMarkdown, computeLineDiff, applySearchReplacePatches } from "../src/shared/parser.js";

describe("parseAIResponse", () => {
  it("returns empty array for empty inputs", () => {
    expect(parseAIResponse("")).toEqual([]);
    expect(parseAIResponse(null)).toEqual([]);
  });

  it("parses pure text as a single text part", () => {
    expect(parseAIResponse("Hello, I am Orbit.")).toEqual([
      { type: "text", content: "Hello, I am Orbit." }
    ]);
  });

  it("extracts execute_command blocks correctly", () => {
    const input = "Here is the command:\n<execute_command>npm run dev</execute_command>\nRun it!";
    expect(parseAIResponse(input)).toEqual([
      { type: "text", content: "Here is the command:\n" },
      { type: "execute_command", path: undefined, content: "npm run dev" },
      { type: "text", content: "\nRun it!" }
    ]);
  });

  it("extracts write_file blocks with paths correctly", () => {
    const input = "I will write this file:\n<write_file path=\"src/index.js\">console.log('hi');</write_file>";
    expect(parseAIResponse(input)).toEqual([
      { type: "text", content: "I will write this file:\n" },
      { type: "write_file", path: "src/index.js", content: "console.log('hi');" }
    ]);
  });

  it("extracts self-closing read_file tags correctly", () => {
    const input = "Let's read package:\n<read_file path=\"package.json\" />\nDone.";
    expect(parseAIResponse(input)).toEqual([
      { type: "text", content: "Let's read package:\n" },
      { type: "read_file", path: "package.json" },
      { type: "text", content: "\nDone." }
    ]);
  });

  it("extracts self-closing click_pixel tags correctly", () => {
    const input = "Click here:\n<click_pixel x=\"800\" y=\"600\" />\nDone.";
    expect(parseAIResponse(input)).toEqual([
      { type: "text", content: "Click here:\n" },
      { type: "click_pixel", x: 800, y: 600 },
      { type: "text", content: "\nDone." }
    ]);
  });

  it("extracts open_browser tags correctly (self-closing and paired)", () => {
    const input1 = "Open this link:\n<open_browser url=\"https://google.com\" />\nGreat.";
    expect(parseAIResponse(input1)).toEqual([
      { type: "text", content: "Open this link:\n" },
      { type: "open_browser", url: "https://google.com" },
      { type: "text", content: "\nGreat." }
    ]);

    const input2 = "<open_browser url=\"https://github.com\"></open_browser>";
    expect(parseAIResponse(input2)).toEqual([
      { type: "open_browser", url: "https://github.com", content: "" }
    ]);
  });

  it("extracts deploy_agent tags correctly (self-closing and paired)", () => {
    const input1 = "Let's code:\n<deploy_agent task=\"Write a python script\" />";
    expect(parseAIResponse(input1)).toEqual([
      { type: "text", content: "Let's code:\n" },
      { type: "deploy_agent", task: "Write a python script" }
    ]);

    const input2 = "<deploy_agent task=\"Refactor code\">some context</deploy_agent>";
    expect(parseAIResponse(input2)).toEqual([
      { type: "deploy_agent", task: "Refactor code", content: "some context" }
    ]);
  });
});

describe("renderMarkdown", () => {
  it("escapes html characters to prevent script injection", () => {
    const input = "<div>Hello & welcome</div>";
    expect(renderMarkdown(input)).toEqual("&lt;div&gt;Hello &amp; welcome&lt;/div&gt;");
  });

  it("formats inline code correctly", () => {
    const input = "Use `const x = 5` to declare it.";
    expect(renderMarkdown(input)).toEqual("Use <code>const x = 5</code> to declare it.");
  });

  it("formats bold text correctly", () => {
    const input = "This is **extremely important**.";
    expect(renderMarkdown(input)).toEqual("This is <strong>extremely important</strong>.");
  });

  it("formats code blocks with a copy button", () => {
    const input = "```js\nconsole.log(1);\n```";
    expect(renderMarkdown(input)).toContain("Copy");
    expect(renderMarkdown(input)).toContain("<pre><code>console.log(1);\n</code>");
  });

  it("formats headings correctly", () => {
    expect(renderMarkdown("# Main")).toEqual("<h1>Main</h1>");
    expect(renderMarkdown("## Sub")).toEqual("<h2>Sub</h2>");
    expect(renderMarkdown("### Small")).toEqual("<h3>Small</h3>");
  });

  it("formats bullet lists correctly", () => {
    const input = "* Item 1\n* Item 2";
    expect(renderMarkdown(input)).toEqual("<ul><li>Item 1</li><li>Item 2</li></ul>");
  });
});

describe("computeLineDiff", () => {
  it("calculates diff with only additions for a new file", () => {
    const oldText = "";
    const newText = "line 1\nline 2";
    const res = computeLineDiff(oldText, newText);
    expect(res.additions).toBe(2);
    expect(res.deletions).toBe(0);
    expect(res.diff).toEqual([
      { type: "added", text: "line 1" },
      { type: "added", text: "line 2" }
    ]);
  });

  it("calculates diff with additions, deletions, and common lines", () => {
    const oldText = "first\nsecond\nthird";
    const newText = "first\nchanged second\nthird\nfourth";
    const res = computeLineDiff(oldText, newText);
    expect(res.additions).toBe(2);
    expect(res.deletions).toBe(1);
    expect(res.diff).toEqual([
      { type: "common", text: "first" },
      { type: "deleted", text: "second" },
      { type: "added", text: "changed second" },
      { type: "common", text: "third" },
      { type: "added", text: "fourth" }
    ]);
  });
});

describe("applySearchReplacePatches", () => {
  it("applies a single search/replace block successfully", () => {
    const original = "line 1\nline 2\nline 3";
    const patch = "<<<<<<< SEARCH\nline 2\n=======\nline two\n>>>>>>> REPLACE";
    expect(applySearchReplacePatches(original, patch)).toEqual("line 1\nline two\nline 3");
  });

  it("applies multiple search/replace blocks successfully", () => {
    const original = "line 1\nline 2\nline 3\nline 4";
    const patch = "<<<<<<< SEARCH\nline 2\n=======\nline two\n>>>>>>> REPLACE\n\n<<<<<<< SEARCH\nline 4\n=======\nline four\n>>>>>>> REPLACE";
    expect(applySearchReplacePatches(original, patch)).toEqual("line 1\nline two\nline 3\nline four");
  });

  it("normalizes CRLF and LF line endings during match", () => {
    const original = "line 1\r\nline 2\r\nline 3";
    const patch = "<<<<<<< SEARCH\nline 2\n=======\nline two\n>>>>>>> REPLACE";
    expect(applySearchReplacePatches(original, patch)).toEqual("line 1\r\nline two\r\nline 3");
  });

  it("throws error if search block is not found", () => {
    const original = "line 1\nline 2\nline 3";
    const patch = "<<<<<<< SEARCH\nline 99\n=======\nline two\n>>>>>>> REPLACE";
    expect(() => applySearchReplacePatches(original, patch)).toThrow("Could not find search block");
  });
});
