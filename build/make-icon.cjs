// Renders the Orbit app icon from the website's favicon shape (a planet + one
// orbit ring) on the dark brand background, then writes build/icon.png.
// Run:  npx electron build/make-icon.js
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const SIZE = 1024;

// Same mark as the website favicon: solid circle (planet) + one tilted orbit
// ellipse, white, on the near-black brand background (#040406 / #07070b) with
// a soft glow to match the site's white-glow accents.
const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;width:${SIZE}px;height:${SIZE}px;background:transparent;overflow:hidden}</style>
<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0b0b12"/>
      <stop offset="1" stop-color="#040406"/>
    </linearGradient>
    <radialGradient id="vig" cx="0.5" cy="0.4" r="0.7">
      <stop offset="0" stop-color="#15151f"/>
      <stop offset="1" stop-color="#040406" stop-opacity="0"/>
    </radialGradient>
    <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="13" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="1024" height="1024" rx="232" fill="url(#bg)"/>
  <rect width="1024" height="1024" rx="232" fill="url(#vig)"/>
  <g transform="translate(512,512)" filter="url(#glow)">
    <circle r="150" fill="#ffffff"/>
    <g transform="rotate(-20)">
      <ellipse rx="372" ry="150" fill="none" stroke="#ffffff" stroke-opacity="0.6" stroke-width="22"/>
      <circle cx="372" cy="0" r="19" fill="#ffffff"/>
    </g>
  </g>
</svg>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE, height: SIZE, show: false, frame: false,
    transparent: true, backgroundColor: "#00000000",
    webPreferences: { offscreen: false }
  });
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  fs.writeFileSync(path.join(__dirname, "icon.png"), img.toPNG());
  console.log("wrote build/icon.png");
  app.quit();
});
