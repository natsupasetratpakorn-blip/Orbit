import { describe, expect, it } from "vitest";

import {
  BAR_HEIGHT,
  COLLAPSED_WIDTH,
  EXPANDED_HEIGHT,
  EXPANDED_WIDTH,
  MISSION_CONTROL_HEIGHT,
  MISSION_CONTROL_WIDTH,
  getOverlayBounds
} from "../src/shared/overlay-window.js";

describe("getOverlayBounds", () => {
  it("centers the collapsed bar at the top of the primary display", () => {
    expect(
      getOverlayBounds({
        displayWidth: 1440,
        state: "collapsed"
      })
    ).toEqual({
      x: 320,
      y: 12,
      width: COLLAPSED_WIDTH,
      height: BAR_HEIGHT
    });
  });

  it("keeps the same top-center anchor when expanded", () => {
    expect(
      getOverlayBounds({
        displayWidth: 1440,
        state: "expanded"
      })
    ).toEqual({
      x: 245,
      y: 12,
      width: EXPANDED_WIDTH,
      height: EXPANDED_HEIGHT
    });
  });

  it("sets width to collapsed width and height to 480px when dropdown-open", () => {
    expect(
      getOverlayBounds({
        displayWidth: 1440,
        state: "dropdown-open"
      })
    ).toEqual({
      x: 320,
      y: 12,
      width: COLLAPSED_WIDTH,
      height: 480
    });
  });

  it("centers the desktop mission-control window on the active display", () => {
    expect(
      getOverlayBounds({
        displayWidth: 1920,
        displayHeight: 1080,
        state: "mission-control"
      })
    ).toEqual({
      x: 240,
      y: 90,
      width: MISSION_CONTROL_WIDTH,
      height: MISSION_CONTROL_HEIGHT
    });
  });
});
