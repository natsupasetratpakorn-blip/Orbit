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
