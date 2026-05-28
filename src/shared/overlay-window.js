// Single width for both collapsed and expanded so the panel and bar always
// line up perfectly — earlier mismatch (1050 vs 950) made the bar look like
// it shrank from the right when the panel opened, clipping the Send button.
export const COLLAPSED_WIDTH = 800;
export const EXPANDED_WIDTH = 950;
export const MISSION_CONTROL_WIDTH = 1440;
export const BAR_HEIGHT = 40;
export const HOVER_HEIGHT = 52;
export const EXPANDED_HEIGHT = 820;
export const MISSION_CONTROL_HEIGHT = 900;
export const TOP_OFFSET = 12;

export function getOverlayBounds({ displayWidth, displayHeight = 900, state }) {
  if (state === "mission-control") {
    const width = Math.min(MISSION_CONTROL_WIDTH, displayWidth);
    const height = Math.min(MISSION_CONTROL_HEIGHT, displayHeight);
    return {
      x: Math.round((displayWidth - width) / 2),
      y: Math.round((displayHeight - height) / 2),
      width,
      height
    };
  }

  const width = state === "expanded" ? EXPANDED_WIDTH : COLLAPSED_WIDTH;
  const height = state === "expanded"
    ? EXPANDED_HEIGHT
    : state === "dropdown-open"
      ? 230
      : state === "hover"
        ? HOVER_HEIGHT
        : BAR_HEIGHT;

  return {
    x: Math.round((displayWidth - width) / 2),
    y: TOP_OFFSET,
    width,
    height
  };
}
