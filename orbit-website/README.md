# Orbit — Landing Site

A modern, animated marketing site for Orbit, the screen-aware desktop AI copilot
powered by the Voyager model series.

- **Theme:** monochrome (black & white) "deep space" / Voyager.
- **Stack:** zero dependencies — plain HTML, CSS, and ES-module JavaScript.
  Fonts load from Google Fonts; everything else is self-contained.

## Preview

Just open `index.html` in a browser:

```bash
# from the repo root
start orbit-website/index.html      # Windows
```

Or serve it (recommended, so module scripts load cleanly over http):

```bash
npx serve orbit-website
# or
python -m http.server 8080 --directory orbit-website
```

## Files

| File         | Purpose                                                        |
|--------------|----------------------------------------------------------------|
| `index.html` | Markup & content (hero, features, models, modes, voice, CTA).  |
| `styles.css` | Monochrome theme, glassmorphism, layout, all keyframes.        |
| `script.js`  | Starfield canvas, cursor constellation, scroll reveals, counters, typing, card tilt, magnetic buttons, voice waveform. |

## Animations

Starfield with parallax + twinkle + shooting stars, a cursor "constellation"
that links nearby stars to the pointer, scroll-reveal on every section,
animated stat counters, a typing demo in the hero window, 3D card tilt with a
cursor spotlight, magnetic buttons, a synthetic voice waveform, an orbiting
logo mark, a marquee, and a scroll-progress bar. All motion is disabled under
`prefers-reduced-motion`.
