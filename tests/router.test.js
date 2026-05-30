import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, DEFAULT_MODEL_ID, MODEL_IDS, normalizeModel, routeAutoModel } from "../src/shared/models.js";
import { DEFAULT_MODEL_ID as GATEWAY_DEFAULT_MODEL_ID } from "../gateway/config.js";

describe("routeAutoModel", () => {
  it("sends planning mode to Orchestra", () => {
    expect(routeAutoModel({ text: "plan this", mode: "planning" })).toBe("Orchestra 1.1");
  });

  it("escalates coding/agent/long work to the strong tier", () => {
    expect(routeAutoModel({ text: "debug this stack trace", turnCount: 1 })).toBe("Voyager 2.1 Preview");
    expect(routeAutoModel({ text: "do it", agentMode: true, turnCount: 2 })).toBe("Voyager 2.1 Preview");
    expect(routeAutoModel({ text: "```js\ncode\n```", turnCount: 1 })).toBe("Voyager 2.1 Preview");
  });

  it("only routes a tiny first-turn opener to the lite tier", () => {
    expect(routeAutoModel({ text: "hi", turnCount: 1 })).toBe("Voyager 1 Flash");
    expect(routeAutoModel({ text: "thanks!", turnCount: 1 })).toBe("Voyager 1 Flash");
  });

  it("keeps real first-turn questions off the context-weak lite tier", () => {
    expect(routeAutoModel({ text: "which keyboard is good for gaming?", turnCount: 1 })).toBe("Voyager 1");
  });

  it("never uses the lite tier for follow-up turns (coreference matters)", () => {
    // The bug this guards against: "find me a good one" downgraded to lite,
    // which then asks "a good what?" instead of using earlier context.
    expect(routeAutoModel({ text: "can you find a good one for me", turnCount: 3 })).toBe("Voyager 1");
    expect(routeAutoModel({ text: "ok", turnCount: 5 })).toBe("Voyager 1");
  });

  it("falls back to the non-lite default model for unknown names", () => {
    expect(normalizeModel("Definitely Not A Model")).toBe(DEFAULT_MODEL);
    expect(DEFAULT_MODEL_ID).toBe(MODEL_IDS[DEFAULT_MODEL]);
    expect(DEFAULT_MODEL_ID).toBe("gemini-2.5-flash");
    expect(GATEWAY_DEFAULT_MODEL_ID).toBe(DEFAULT_MODEL_ID);
  });
});
