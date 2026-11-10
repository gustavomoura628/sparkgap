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
  needs 80% over its last 10. Every character's median reaction time must also be at or under the
  target (500 ms by default, adjustable in settings). Characters follow the LCWO order.
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

## Lessons and statistics

A lesson is 50 answers, about one minute of drilling at full speed. A break of more than 10 minutes
starts a new lesson; otherwise an unfinished lesson continues after a reload. Practice time counts
only active drilling, and pauses do not count.

If no key is pressed for 5 seconds after a character finishes, the drill stops. The unanswered
character is dropped: it is not recorded, and the time since the previous answer counts toward
neither the lesson nor practice time. The next key starts the drill again with a different
character, so the dropped one cannot be remembered and answered late.

Above the prompt, a strip of 50 cells tracks the current lesson. The character being played is a
masked cell, so it cannot be read before it is heard; answered characters are revealed, and misses are
marked in red (hover one to see what was typed).

The practice screen also shows, for the last complete lesson:

- **Reaction**: median time from the end of a character to your key press, for correct answers.
- **Accuracy**, **score**, and **copy speed**, each with the change from the lesson before.
- The newest character's progress toward the target, your current run of lessons at 95% or better,
  progress through the current lesson, and today's practice time against the daily goal (15 minutes by default).

The **Profile** page has all-time and today totals, accuracy streaks (longest runs at 100%, 97% and
95%), a lesson-by-lesson heat map per character, reaction time, accuracy and characters unlocked over
time, a per-character reaction chart with its learning rate, per-character averages, hits and misses,
a Morse tree shaded by speed or miss rate, a confusion matrix of wrong answers, and a practice calendar.
Every chart can be read with the keyboard (focus it, then use the arrow keys) and has a table view.

The **Music** switch at the top of the practice page marks answers given while listening to music. It
stays on until switched off, across reloads. The profile compares reaction time and accuracy with and
without music, matching the same character at the same level so a different character mix does not
skew the result.

**Copy speed** is `12000 / (character duration ms + reaction time ms)` in words per minute: the rate at
which characters could be copied if each took its playing time plus your reaction time.
**Score** gives each correct answer `level × 1000 / (reaction ms + 500)` points, then multiplies the
total by the lesson's accuracy, so larger character sets and faster answers score more.

## Data

With the server running, history is appended to `data/attempts.jsonl`, one JSON object per answer:

```json
{"t":"2026-01-01T12:00:00.000Z","mode":"letters","char":"K","answer":"K","correct":true,"rtMs":412,"replays":0,"level":2,"wpm":20,"frequency":600,"lesson":0,"durMs":1180,"charMs":540,"copyWpm":12.9,"music":false}
```

`rtMs` is negative when the answer came before the character finished playing. Newer records also carry
`lesson`, `durMs` (active time credited to the answer), `charMs` (how long the character played) and
`copyWpm`. Older records without them get them derived from their timestamps. `music` records the
state of the **Music** switch on the practice page; answers recorded before it existed do not have it.
Use `--data-dir` to store data somewhere else. Settings are kept in `settings.json` in the same directory.

Without the server, for example on static hosting, the app keeps history in the browser's `localStorage`.
**Export history** in the settings dialog downloads it as JSON, together with its format version.

### Updating

```sh
git pull
```

Then reload the page. History carries a format version (`data/meta.json`, or `sparkgap.meta` in
`localStorage`). When an update changes the format, the app upgrades existing history on first load,
one version at a time, and keeps a backup of the previous file
(`data/attempts.v<old version>.<timestamp>.jsonl.bak`, or `sparkgap.attempts.backup` in the browser).
History saved by a newer version of the app is never modified by an older one.

| Version | Change |
|---|---|
| 1 | Original format, before versioning |
| 2 | Every answer stores `lesson`, `durMs`, `charMs` and `copyWpm` |
| 3 | Lessons regrouped into 50 answers each (previously one minute of active time) |

## Development

```sh
node --test tests/*.test.mjs   # unit tests (Node 18+)
```

To change the history format, append a migration to `MIGRATIONS` in `web/js/migrations.js` with the
next version number, add a row to the version table above, and add a test. A migration must not call
code that may change later; copy any logic it needs into `migrations.js`. Never edit a migration that
has already been released: existing histories have already run it.

| Path | Contents |
|---|---|
| `server.py` | Static file server and JSON storage API |
| `web/js/morse.js` | Code table, Koch order, PARIS and Farnsworth timing |
| `web/js/trainer.js` | Unlock rules, character weighting, mastery score |
| `web/js/audio.js` | Web Audio playback with click-free tone shaping |
| `web/js/migrations.js` | History format versions and upgrades |
| `web/js/stats.js` | Lesson grouping, streaks, practice time, per-character statistics |
| `web/js/charts.js` | SVG line, bar and heat-grid charts with tooltips and table views |
| `web/js/app.js` | Drill UI and keyboard handling |
| `web/js/profile.js` | Profile page |

## License

Code: MIT, see [LICENSE](LICENSE).
The bundled Barlow Semi Condensed font is licensed under the SIL Open Font License 1.1, see [web/fonts/OFL.txt](web/fonts/OFL.txt).
