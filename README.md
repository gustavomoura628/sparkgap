# sparkgap

Learn Morse code by ear. sparkgap is an adaptive Koch trainer: it plays one character at full speed,
you type what you heard, and it decides what to play next from your accuracy and reaction time.

No build step, no dependencies. A Python 3.10+ standard-library server and a browser are all it needs.

## Quick start

```sh
python3 server.py --open
```

The app opens at <http://127.0.0.1:8073/>. Press any key to start.

| Key | Action |
|---|---|
| Letters, digits, `. , ? / =` | Answer |
| `Space` | Play the character again |
| `Esc` | Pause and open settings |

## How it works

- **Koch method.** Lessons start with two characters (`K`, `M`) sent at full speed (20 wpm by default).
  A new character unlocks after at least 50 answers since the previous unlock, at 90% accuracy or better.
  The newest character needs 15 tries of its own with 90% on its last 10, and every other character
  needs 80% over its last 10. Characters follow the LCWO order.
- **Sound first.** The app never shows dot-dash patterns. Each new character is introduced by playing it
  a few times, so you learn its sound instead of a chart you decode in your head.
- **Adaptive practice.** Characters you miss or answer slowly come up more often. The newest character
  gets extra practice for its first 25 tries. The same character never plays three times in a row.
- **Reaction time.** Every answer records the time from the end of the last tone to the key press.
  Accuracy shows whether you know a character; reaction time shows whether you recognise it instantly.
  Lamp brightness combines both.
- **Learning from misses.** After a miss, the app shows the correct character and plays it again.
  The drill continues once you type the correct character. Only your first answer is recorded.

Rules and thresholds live in [`web/js/trainer.js`](web/js/trainer.js) (`RULES`).

## Data

With the server running, history is appended to `data/attempts.jsonl`, one JSON object per answer:

```json
{"t":"2026-01-01T12:00:00.000Z","mode":"letters","char":"K","answer":"K","correct":true,"rtMs":412,"replays":0,"level":2,"wpm":20,"frequency":600}
```

`rtMs` is negative when the answer came before the character finished playing.
Use `--data-dir` to store data somewhere else. Settings are kept in `settings.json` in the same directory.

Without the server, for example on static hosting, the app keeps history in the browser's `localStorage`.
**Export history** in the settings dialog downloads it as JSON.

## Development

```sh
node --test tests/*.test.mjs   # unit tests for timing and lesson logic (Node 18+)
```

| Path | Contents |
|---|---|
| `server.py` | Static file server and JSON storage API |
| `web/js/morse.js` | Code table, Koch order, PARIS and Farnsworth timing |
| `web/js/trainer.js` | Unlock rules, character weighting, mastery score |
| `web/js/audio.js` | Web Audio playback with click-free tone shaping |
| `web/js/app.js` | Drill UI and keyboard handling |

## License

Code: MIT, see [LICENSE](LICENSE).
The bundled Barlow Semi Condensed font is licensed under the SIL Open Font License 1.1, see [web/fonts/OFL.txt](web/fonts/OFL.txt).
