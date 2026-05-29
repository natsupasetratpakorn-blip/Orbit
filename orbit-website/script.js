// ════════════════════════════════════════════════════════════════════
// ORBIT landing — interactions & animation. Vanilla, no dependencies.
// Everything stays strictly black-and-white to match the theme.
// ════════════════════════════════════════════════════════════════════
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ─── Footer year ──────────────────────────────────────────────────────
$("#year").textContent = new Date().getFullYear();

// ─── Nav: scrolled state + scroll progress + mobile menu ───────────────
const nav = $("#nav");
const progress = $("#scrollProgress");
const navLinks = $(".nav-links");
$("#navBurger").addEventListener("click", () => navLinks.classList.toggle("open"));
$$(".nav-links a").forEach((a) => a.addEventListener("click", () => navLinks.classList.remove("open")));

function onScroll() {
  const y = window.scrollY;
  nav.classList.toggle("scrolled", y > 24);
  const h = document.documentElement.scrollHeight - window.innerHeight;
  progress.style.width = `${h > 0 ? (y / h) * 100 : 0}%`;
}
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

// ─── Scroll reveal ──────────────────────────────────────────────────────
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add("in");
        io.unobserve(e.target);
      }
    }
  },
  { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
);
$$(".reveal").forEach((el) => io.observe(el));

// ─── Animated counters ──────────────────────────────────────────────────
function animateCount(el) {
  const text = el.dataset.text; // e.g. "∞" — show verbatim, no count
  if (text) { el.textContent = text; return; }
  const target = parseFloat(el.dataset.count || "0");
  const dur = 1400;
  const start = performance.now();
  function tick(now) {
    const t = Math.min((now - start) / dur, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(target * eased).toString();
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
const countIO = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { animateCount(e.target); countIO.unobserve(e.target); }
    }
  },
  { threshold: 0.6 }
);
$$(".stat-num").forEach((el) => (reduceMotion ? (el.textContent = el.dataset.text || el.dataset.count) : countIO.observe(el)));

// ─── Hero typing effect ─────────────────────────────────────────────────
const typeTarget = $("#typeTarget");
if (typeTarget && !reduceMotion) {
  const full = "On it — reading the handler, applying a focused patch, then verifying.";
  let i = 0;
  const tick = () => {
    typeTarget.textContent = full.slice(0, i);
    i++;
    if (i <= full.length) setTimeout(tick, 26 + Math.random() * 30);
    else typeTarget.parentElement.classList.add("done");
  };
  setTimeout(tick, 900);
} else if (typeTarget) {
  typeTarget.textContent = "On it — patching and verifying.";
  typeTarget.parentElement.classList.add("done");
}

// ─── Magnetic buttons ───────────────────────────────────────────────────
if (!reduceMotion) {
  $$(".magnetic").forEach((btn) => {
    btn.addEventListener("mousemove", (e) => {
      const r = btn.getBoundingClientRect();
      const mx = e.clientX - r.left - r.width / 2;
      const my = e.clientY - r.top - r.height / 2;
      btn.style.transform = `translate(${mx * 0.22}px, ${my * 0.32}px)`;
    });
    btn.addEventListener("mouseleave", () => { btn.style.transform = ""; });
  });
}

// ─── Card tilt + cursor spotlight ───────────────────────────────────────
if (!reduceMotion) {
  $$(".tilt").forEach((card) => {
    card.addEventListener("mousemove", (e) => {
      const r = card.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width;
      const py = (e.clientY - r.top) / r.height;
      card.style.setProperty("--mx", `${px * 100}%`);
      card.style.setProperty("--my", `${py * 100}%`);
      const rx = (py - 0.5) * -6;
      const ry = (px - 0.5) * 6;
      card.style.transform = `perspective(800px) rotateX(${rx}deg) rotateY(${ry}deg) translateY(-4px)`;
    });
    card.addEventListener("mouseleave", () => { card.style.transform = ""; });
  });
}

// ─── Mode selector ──────────────────────────────────────────────────────
$$(".mode").forEach((m) => {
  m.addEventListener("click", () => {
    $$(".mode").forEach((x) => x.classList.remove("is-active"));
    m.classList.add("is-active");
  });
});

// ─── Cursor glow + canvas-space pointer for the starfield ───────────────
const glow = $("#cursorGlow");
let mousePxX = -9999, mousePxY = -9999;
let targetMX = 0.5, targetMY = 0.5;
if (!reduceMotion) {
  window.addEventListener("mousemove", (e) => {
    mousePxX = e.clientX; mousePxY = e.clientY;
    targetMX = e.clientX / window.innerWidth;
    targetMY = e.clientY / window.innerHeight;
    glow.style.transform = `translate3d(${e.clientX}px, ${e.clientY}px, 0) translate(-50%, -50%)`;
  });
  window.addEventListener("mouseleave", () => { mousePxX = -9999; mousePxY = -9999; });
} else {
  glow.style.display = "none";
}

// ─── Starfield: parallax stars, twinkle, constellation, shooting stars ──
(function starfield() {
  const canvas = $("#space");
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
  let mx = 0.5, my = 0.5;

  let stars = [];
  function build() {
    const count = Math.round((W * H) / 6500); // density scales with viewport
    stars = Array.from({ length: count }, () => ({
      x: Math.random(), y: Math.random(),
      a: 0.06 + Math.random() * 0.5,
      s: 0.4 + Math.random() * 1.7,
      tw: 0.0005 + Math.random() * 0.0016,
      ph: Math.random() * Math.PI * 2,
      px: 0.3 + Math.random() * 1.8
    }));
  }
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    build();
  }

  const shooting = [];
  function maybeShoot() {
    if (reduceMotion) return;
    if (shooting.length >= 2 || Math.random() > 0.005) return;
    const fromLeft = Math.random() < 0.5;
    shooting.push({
      x: fromLeft ? -40 : W + 40, y: Math.random() * H * 0.55,
      vx: (fromLeft ? 1 : -1) * (7 + Math.random() * 5), vy: 2.2 + Math.random() * 2, life: 1
    });
  }

  function frame(time) {
    mx += (targetMX - mx) * 0.05;
    my += (targetMY - my) * 0.05;
    ctx.clearRect(0, 0, W, H);

    const offX = (mx - 0.5) * 36, offY = (my - 0.5) * 36;
    const LINK = 140;
    const near = [];

    for (const st of stars) {
      const twinkle = 0.5 + 0.5 * Math.sin(time * st.tw + st.ph);
      const x = st.x * W - offX * st.px;
      const y = st.y * H - offY * st.px;
      let prox = 0;
      if (mousePxX > -9000) {
        const d = Math.hypot(x - mousePxX, y - mousePxY);
        prox = d < LINK ? 1 - d / LINK : 0;
      }
      const alpha = Math.min(1, st.a * (0.4 + 0.6 * twinkle) + prox * 0.6);
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      const size = st.s + prox * 1.6;
      ctx.fillRect(x, y, size, size);
      if (prox > 0) near.push({ x, y, prox });
    }

    // Constellation links from cursor to nearby stars
    for (const n of near) {
      ctx.strokeStyle = `rgba(255,255,255,${n.prox * 0.22})`;
      ctx.lineWidth = 0.6;
      ctx.beginPath(); ctx.moveTo(mousePxX, mousePxY); ctx.lineTo(n.x, n.y); ctx.stroke();
    }

    // Shooting stars
    maybeShoot();
    for (let i = shooting.length - 1; i >= 0; i--) {
      const s = shooting[i];
      s.x += s.vx; s.y += s.vy; s.life -= 0.012;
      if (s.life <= 0 || s.x < -80 || s.x > W + 80 || s.y > H + 80) { shooting.splice(i, 1); continue; }
      const tx = s.x - s.vx * 6, ty = s.y - s.vy * 6;
      const g = ctx.createLinearGradient(s.x, s.y, tx, ty);
      g.addColorStop(0, `rgba(255,255,255,${0.9 * s.life})`);
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.strokeStyle = g; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(tx, ty); ctx.stroke();
    }

    requestAnimationFrame(frame);
  }

  resize();
  window.addEventListener("resize", resize);
  if (reduceMotion) {
    // Draw a single static field, no loop.
    ctx.clearRect(0, 0, W, H);
    for (const st of stars) { ctx.fillStyle = `rgba(255,255,255,${st.a})`; ctx.fillRect(st.x * W, st.y * H, st.s, st.s); }
  } else {
    requestAnimationFrame(frame);
  }
})();

// ─── Voice waveform (monochrome, synthetic) ─────────────────────────────
(function waveform() {
  const canvas = $("#wave");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
  let visible = false;

  function resize() {
    const r = canvas.getBoundingClientRect();
    W = r.width; H = r.height;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const vio = new IntersectionObserver((es) => es.forEach((e) => (visible = e.isIntersecting)), { threshold: 0.1 });
  vio.observe(canvas);

  function wave(t, amp, freq, phase, alpha, lw) {
    ctx.beginPath();
    for (let x = 0; x <= W; x += 4) {
      const env = Math.sin((x / W) * Math.PI); // fade at edges
      const y = H / 2 + Math.sin(x * freq + t + phase) * amp * env
        * (0.6 + 0.4 * Math.sin(t * 1.7 + x * 0.01));
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
    ctx.lineWidth = lw; ctx.stroke();
  }

  function frame(time) {
    requestAnimationFrame(frame);
    if (!visible) return;
    const t = time * 0.0028;
    ctx.clearRect(0, 0, W, H);
    wave(t, H * 0.18, 0.020, 0, 0.16, 1);
    wave(-t * 1.2, H * 0.26, 0.026, 1.2, 0.5, 1.4);
    wave(t * 1.5, H * 0.34, 0.032, 2.4, 0.9, 1.8);
  }
  resize();
  window.addEventListener("resize", resize);
  if (!reduceMotion) requestAnimationFrame(frame);
  else { resize(); wave(0, H * 0.2, 0.03, 0, 0.6, 1.6); }
})();

// ════════════════════════════════════════════════════════════════════
// CREATIVE LAYER v2
// ════════════════════════════════════════════════════════════════════

// ─── Custom reticle cursor (fine pointers) ──────────────────────────────
(function reticle() {
  if (!window.matchMedia("(pointer: fine)").matches) return;
  const el = $("#reticle");
  document.body.classList.add("has-reticle");
  let x = window.innerWidth / 2, y = window.innerHeight / 2, tx = x, ty = y;
  window.addEventListener("mousemove", (e) => { tx = e.clientX; ty = e.clientY; });
  window.addEventListener("mousedown", () => el.classList.add("click"));
  window.addEventListener("mouseup", () => el.classList.remove("click"));
  const interactive = "a, button, .mode, .card, .model-card, .preset, input, .badge";
  document.addEventListener("mouseover", (e) => { if (e.target.closest(interactive)) el.classList.add("lock"); });
  document.addEventListener("mouseout", (e) => { if (e.target.closest(interactive)) el.classList.remove("lock"); });
  (function loop() {
    x += (tx - x) * 0.28; y += (ty - y) * 0.28;
    el.style.transform = `translate(${x}px, ${y}px)`;
    requestAnimationFrame(loop);
  })();
})();

// ─── Telemetry HUD ──────────────────────────────────────────────────────
(function hud() {
  const clock = $("#hudClock"), coords = $("#hudCoords"), depth = $("#hudDepth"), dist = $("#hudDist");
  const t0 = Date.now();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    clock.textContent = `T+${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  }, 1000);
  window.addEventListener("mousemove", (e) => {
    coords.textContent = `x${pad(Math.round(e.clientX), 4)} · y${pad(Math.round(e.clientY), 4)}`;
  });
  function onScrollHud() {
    const h = document.documentElement.scrollHeight - window.innerHeight;
    const f = h > 0 ? window.scrollY / h : 0;
    depth.textContent = `${Math.round(f * 100)}%`;
    dist.textContent = `${(f * 122.84).toFixed(3).padStart(7, "0")} AU`;
  }
  window.addEventListener("scroll", onScrollHud, { passive: true });
  onScrollHud();
})();

// ─── Trajectory probe (tracks scroll) ───────────────────────────────────
(function trajectory() {
  const probe = $("#trajProbe");
  if (!probe) return;
  function move() {
    const h = document.documentElement.scrollHeight - window.innerHeight;
    const f = h > 0 ? window.scrollY / h : 0;
    probe.style.top = `${12 + f * 76}%`; // rail spans 12%..88%
  }
  window.addEventListener("scroll", move, { passive: true });
  move();
})();

// ─── Signal-decode text scramble ────────────────────────────────────────
(function scramble() {
  const GLYPHS = "▖▘▝▗▚▞01·:/\\<>=*+ABCDEFGHJKLMNPRSTUVWXYZ";
  function run(el) {
    const final = el.dataset.final || el.textContent;
    el.dataset.final = final;
    if (reduceMotion) { el.textContent = final; return; }
    const len = final.length;
    let frame = 0;
    el.setAttribute("data-scrambling", "");
    const total = 22 + len * 1.2;
    function tick() {
      let out = "";
      for (let i = 0; i < len; i++) {
        const reveal = (frame - 8) / 1.4; // chars resolve left→right
        if (final[i] === " ") { out += " "; continue; }
        out += i < reveal ? final[i] : GLYPHS[(Math.random() * GLYPHS.length) | 0];
      }
      el.textContent = out;
      frame++;
      if (frame <= total) requestAnimationFrame(tick);
      else { el.textContent = final; el.removeAttribute("data-scrambling"); }
    }
    tick();
  }
  const targets = [...$$("[data-scramble]"), ...$$(".eyebrow")];
  const sio = new IntersectionObserver((es) => {
    es.forEach((e) => { if (e.isIntersecting) { run(e.target); sio.unobserve(e.target); } });
  }, { threshold: 0.8 });
  targets.forEach((t) => sio.observe(t));
})();

// ─── Golden Record shine (rotates with scroll) ──────────────────────────
(function record() {
  const rec = $("#record");
  if (!rec) return;
  const shine = rec.querySelector(".record-shine");
  window.addEventListener("scroll", () => {
    shine.style.setProperty("--shine", `${window.scrollY * 0.4}deg`);
  }, { passive: true });
})();

// ─── Interactive orbital system (hero background) ───────────────────────
(function orbits() {
  const canvas = $("#orbits");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
  let mx = 0.5, my = 0.5, tmx = 0.5, tmy = 0.5, visible = true;

  const planets = [
    { r: 0.14, size: 2.2, speed: 0.00050, a: 0.85 },
    { r: 0.22, size: 3.4, speed: 0.00034, a: 0.62 },
    { r: 0.31, size: 2.6, speed: 0.00024, a: 0.55 },
    { r: 0.42, size: 4.6, speed: 0.00016, a: 0.5 },
    { r: 0.54, size: 1.8, speed: 0.00011, a: 0.45 }
  ];

  function resize() {
    const r = canvas.getBoundingClientRect();
    W = r.width; H = r.height;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("mousemove", (e) => { tmx = e.clientX / window.innerWidth; tmy = e.clientY / window.innerHeight; });
  const oio = new IntersectionObserver((es) => es.forEach((e) => (visible = e.isIntersecting)), { threshold: 0.01 });
  oio.observe(canvas);

  function frame(time) {
    requestAnimationFrame(frame);
    if (!visible) return;
    mx += (tmx - mx) * 0.04; my += (tmy - my) * 0.04;
    ctx.clearRect(0, 0, W, H);
    const base = Math.min(W, H);
    const cx = W / 2 + (mx - 0.5) * 70;
    const cy = H * 0.46 + (my - 0.5) * 70;

    // Core glow
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, base * 0.16);
    core.addColorStop(0, "rgba(255,255,255,0.16)");
    core.addColorStop(0.5, "rgba(255,255,255,0.04)");
    core.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = core; ctx.beginPath(); ctx.arc(cx, cy, base * 0.16, 0, Math.PI * 2); ctx.fill();

    for (let i = 0; i < planets.length; i++) {
      const p = planets[i];
      const rx = base * p.r * 1.35, ry = base * p.r * 0.5;
      // Orbit ellipse
      ctx.strokeStyle = `rgba(255,255,255,${0.05 + (i % 2) * 0.02})`;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, -0.2, 0, Math.PI * 2); ctx.stroke();
      // Planet
      const ang = time * p.speed + i * 1.7;
      const x = cx + Math.cos(ang) * rx, y = cy + Math.sin(ang) * ry;
      const halo = ctx.createRadialGradient(x, y, 0, x, y, p.size * 7);
      halo.addColorStop(0, `rgba(255,255,255,${p.a})`);
      halo.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(x, y, p.size * 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${p.a})`;
      ctx.beginPath(); ctx.arc(x, y, p.size, 0, Math.PI * 2); ctx.fill();
    }
  }
  resize();
  window.addEventListener("resize", resize);
  if (!reduceMotion) requestAnimationFrame(frame);
})();

// ─── Interactive demo player (scripted "Orbit at work") ─────────────────
(function demo() {
  const screen = $("#demoScreen");
  if (!screen) return;
  const fill = $("#demoFill"), status = $("#demoStatus"), replay = $("#demoReplay");
  const items = $$("#demoList li");
  let token = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const add = (html) => { screen.insertAdjacentHTML("beforeend", html); screen.scrollTop = screen.scrollHeight; return screen.lastElementChild; };
  const setStep = (i) => items.forEach((li, idx) => { li.classList.toggle("active", idx === i); li.classList.toggle("done", idx < i); });
  const setFill = (f) => (fill.style.width = `${Math.round(f * 100)}%`);

  function finalState() {
    screen.innerHTML =
      `<div class="chat-line user"><span class="who">You</span><span class="bubble">Fix the failing auth test</span></div>` +
      `<div class="demo-shot"><span class="shot-ico">▦</span> screen captured · 1440×900 · sent as context</div>` +
      `<div class="tool-card"><div class="tool-head"><span class="tool-dot"></span> patch_file <span class="tool-path">src/auth/verify.ts</span><span class="tool-ok">✓</span></div></div>` +
      `<div class="tool-card"><div class="tool-head"><span class="tool-dot"></span> execute_command <span class="tool-path">npm test</span><span class="tool-ok">✓</span></div></div>` +
      `<div class="chat-line ai"><span class="who">Voyager</span><div class="ai-body done"><p>Fixed: token expiry compared in ms vs s. Patched <code>verify.ts</code> — all 14 tests pass. ✓</p></div></div>`;
    items.forEach((li) => { li.classList.remove("active"); li.classList.add("done"); });
    setFill(1); status.textContent = "Complete ✓";
  }

  async function play() {
    const my = ++token;
    screen.innerHTML = ""; setFill(0); status.textContent = "Running…";
    add(`<div class="chat-line user"><span class="who">You</span><span class="bubble">Fix the failing auth test</span></div>`);
    await sleep(650); if (my !== token) return;

    setStep(0); status.textContent = "Reading screen…";
    add(`<div class="demo-shot"><span class="shot-ico">▦</span> screen captured · 1440×900 · sent as context</div>`);
    setFill(0.2); await sleep(1100); if (my !== token) return;

    setStep(1); status.textContent = "Searching workspace…";
    add(`<div class="tool-card"><div class="tool-head"><span class="tool-dot"></span> search_workspace <span class="tool-path">"verifyToken"</span><span class="tool-ok">✓</span></div></div>`);
    await sleep(650); if (my !== token) return;
    add(`<div class="tool-card"><div class="tool-head"><span class="tool-dot"></span> read_file <span class="tool-path">src/auth/verify.ts</span><span class="tool-ok">✓</span></div></div>`);
    setFill(0.4); await sleep(950); if (my !== token) return;

    setStep(2); status.textContent = "Patching file…";
    add(`<div class="tool-card"><div class="tool-head"><span class="tool-dot"></span> patch_file <span class="tool-path">src/auth/verify.ts</span><span class="tool-ok">✓</span></div></div>`);
    setFill(0.6); await sleep(1000); if (my !== token) return;

    setStep(3); status.textContent = "Running tests…";
    const tc = add(`<div class="tool-card"><div class="tool-head"><span class="tool-dot run"></span> execute_command <span class="tool-path">npm test</span><span class="tool-spin"></span></div></div>`);
    setFill(0.82); await sleep(1700); if (my !== token) return;
    tc.querySelector(".tool-spin").outerHTML = `<span class="tool-ok">✓</span>`;
    tc.querySelector(".tool-dot").classList.remove("run");
    await sleep(500); if (my !== token) return;

    setStep(4); status.textContent = "Reporting…";
    add(`<div class="chat-line ai"><span class="who">Voyager</span><div class="ai-body done"><p>Fixed: token expiry compared in ms vs s. Patched <code>verify.ts</code> — all 14 tests pass. ✓</p></div></div>`);
    setFill(1); await sleep(400); if (my !== token) return;
    items.forEach((li) => { li.classList.remove("active"); li.classList.add("done"); });
    status.textContent = "Complete ✓";
  }

  replay.addEventListener("click", play);
  if (reduceMotion) { finalState(); return; }
  const dio = new IntersectionObserver((es) => {
    es.forEach((e) => { if (e.isIntersecting) { play(); dio.unobserve(e.target); } });
  }, { threshold: 0.4 });
  dio.observe(screen);
})();

