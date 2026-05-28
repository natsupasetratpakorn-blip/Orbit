# Orbit Overlay

A slim Electron desktop overlay shell for screen-aware chat workflows.

## Run

```powershell
npm install
npm start
```

## Test

```powershell
npm test
npm audit --audit-level=moderate
```

## Current Scope

- Always-on-top, frameless, transparent floating bar centered at the top of the primary display.
- Hover height adjustment and click-to-open slide-down chat panel.
- Non-focusable Electron window so the overlay does not take focus from other apps.
- Model selector persisted with local chat history.
- Web Speech API microphone transcription when supported by the runtime.
- Screenshot capture on send, saved under Electron `userData/screenshots`.
- Chat history saved to Electron `userData/chat-history.json`.

AI requests are intentionally stubbed for this first shell pass.
