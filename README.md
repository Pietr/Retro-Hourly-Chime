# Retro Hourly Chime — Zepp OS 3.0+

Classic retro digital watch hourly chime for **Amazfit (Zepp OS 3.0+)** smartwatches — featuring native hardware buzzer tones, 18 studio-mastered MP3 speaker chimes, custom haptic patterns, independent DND/Sleep/Theater controls, and ultra-low battery usage.

## Features

- **Ultra-Low Power Single-Execution Architecture (`@zos/alarm` + `appService.exit()`):**
  - Uses persistent hardware RTC alarms (`store: true`) to wake the chime service only on active top-of-the-hour marks.
  - Automatically jumps over quiet overnight windows (**0 wakeups at night**).
  - Exits immediately after playback via `appService.exit()` (**0 B RAM and 0 background service slots held between hours**).
  - Uses native `@zos/sensor` `Time` (immune to QuickJS timezone/DST drift) with RTC early-wakeup jitter tolerance (`XX:59:55–59:59`).
- **3 Independent Alert Channels with Automatic Hardware Detection:**
  - Automatically detects **Hardware Buzzer**, **Speaker**, and **Vibration Motor** capabilities on each watch model.
  - Unsupported hardware channels are automatically grayed out and their configuration sections hidden without blank spacing.
  - **Hardware Buzzer:** 6 native firmware tones (`Click`, `Remind 1`, `Remind 2`, `Alarm`, `Success`, `Alert`) with hardware repetition count (`1x–4x`) and warning if system Buzzer Scene (*Settings → Sound & Vibration → Buzzer Scene → Other*) is disabled.
  - **Speaker (18 MP3 Chimes):** Classic metallic piezo double-beeps (`Piezo 4k/2k/3.2k/2.7k 500ms`), `Retro 1989`, `Retro Quick`, `Retro Steel`, `Vintage 2k+4k`, multi-pulse, dual-tone, triad, bell, and sonar pings with comfortable -6 dB mastering, fine volume control (`1%–100%`, 5% steps above 10% and 1% steps at ≤10%, default 50%), and automatic system volume restore.
  - **Vibration:** 7 haptic patterns (`2x Short`, `2x Crown`, `3x Fast`, `Short+Long`, `Long+Short`, `1x Single`, `System 2x`) with 3 strength levels (`Light`, `Medium`, `Strong`).
- **Independent Silent Mode Controls (`DND / Sleep / Theater`):**
  - Reads `@zos/settings` (`getSystemMode()`) for Do Not Disturb, Sleep Mode, and Theater Mode.
  - Two separate toggles: **`Mute Audio`** (Buzzer & Speaker) and **`Mute Vibr.`** (Vibration) — allowing you to silence sounds while optionally keeping subtle wrist vibrations.
- **Flexible Active Hours:** 24/7 mode or custom hourly range (`FROM` / `TO`, including overnight ranges).
- **Universal Round & Square UI + 34 Official Zepp OS Languages:**
  - Adapts automatically to round (`360×360`–`480×480`) and square (`320×380`–`432×514`) displays across `NXP`, `ZPS`, and `APOLLO` chipsets.
  - Full UI & launcher localization across all 34 Zepp OS languages (`en-US`, `pl-PL`, `de-DE`, `fr-FR`, `es-ES`, `it-IT`, `pt-PT`, `pt-BR`, `nl-NL`, `ru-RU`, `uk-UA`, `cs-CZ`, `sk-SK`, `hu-HU`, `ro-RO`, `tr-TR`, `el-GR`, `sv-SE`, `nb-NO`, `da-DK`, `fi-FI`, `sr-RS`, `ca-ES`, `zh-CN`, `zh-TW`, `ja-JP`, `ko-KR`, `id-ID`, `ms-MY`, `vi-VN`, `th-TH`, `ar-EG`, `iw-IL`, `hi-IN`).
- **100% Offline & Private:** No companion phone script, no network calls, no telemetry. See [PRIVACY.md](PRIVACY.md).

## Project Structure

- `app.js` — App lifecycle and single RTC schedule sync on exit
- `service/hourly_chime.js` — Single-execution AppService woken by `@zos/alarm`
- `page/gt/home/index.page.js` — Adaptive round & square main UI
- `utils/constants.js` — App version, defaults, and audio/haptic ID maps
- `utils/catalog.js` — UI-only i18n variant catalog (excluded from AppService bundle)
- `utils/storage.js` — Validated atomic settings persistence (`user_settings_v1.json`) separated from runtime state (`runtime_state_v1.json`)
- `utils/audio.js` — Hardware capability detection and Buzzer / MediaPlayer / SystemSounds / Vibrator engine
- `utils/schedule.js` — RTC alarm scheduling, overnight skipping, DND/Sleep/Theater evaluation
- `utils/i18n.js` — `@zos/i18n` helper
- `page/i18n/*.po` — 34 language translation files

## Development & Building

Install dependencies:
```bash
npm install
```

Run in **Zepp OS Simulator**:
```bash
npm run dev
```

Preview on a physical Amazfit watch via QR code (Zepp Developer Mode):
```bash
npm run preview
```

Build universal multi-platform `.zab` package (all 12 round & square hardware profiles) for **Zepp App Store**:
```bash
npm run build
```

## Privacy Policy

This app operates 100% offline on your smartwatch and collects no personal data. Read the full policy in [PRIVACY.md](PRIVACY.md).

## License

MIT License — see [LICENSE](LICENSE).
