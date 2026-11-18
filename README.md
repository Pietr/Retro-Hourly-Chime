# Retro Hourly Chime — Zepp OS 3.0+

Classic retro digital watch hourly chime for **Amazfit (Zepp OS 3.0+)** smartwatches — featuring native hardware buzzer tones, 18 studio-mastered MP3 speaker chimes, custom haptic patterns, independent DND/Sleep/Theater controls, and ultra-low battery usage.

## Features

- **Ultra-Low Power RTC-Driven Architecture (`@zos/alarm` — 0 `onPerMinute` Wakeups):**
  - Uses persistent hardware RTC alarms (`store: true`) to wake `service/hourly_chime.js` **exclusively on active top-of-the-hour marks** (automatically jumping quiet overnight hours and inactive days/weekends with **0 wakeups**).
  - Pure **Single Execution** (0 B RAM between hours) when using native Buzzer `Auto` and/or Vibration; automatically engages a dormant zero-timer `AppService` (0% idle CPU, 0 flash I/O) only when async Speaker MP3 chimes or custom Buzzer repeat gaps (`50–750 ms`) are configured.
  - Uses native `@zos/sensor` `Time` (immune to QuickJS timezone/DST drift) with RTC early-wakeup jitter tolerance (`XX:59:55–59:59`).
- **3 Independent Alert Channels with Automatic Hardware Detection:**
  - Automatically detects **Hardware Buzzer**, **Speaker**, and **Vibration Motor** capabilities on each watch model.
  - Unsupported hardware channels are automatically grayed out and their configuration sections hidden without blank spacing.
  - **Hardware Buzzer:** 6 native firmware tones (`Click`, `Remind 1`, `Remind 2`, `Alarm`, `Success`, `Alert`) with repetition count (`1x–4x`), configurable repeat gap (`Auto` native or `50 ms – 750 ms` in `25 ms` steps), and warning if system Buzzer Scene (*Settings → Sound & Vibration → Buzzer Scene → Other*) is disabled.
  - **Speaker (18 MP3 Chimes):** Starts with `Retro 1989` (default), `Retro Quick`, `Retro Steel`, `Vintage 2k+4k`, multi-pulse, dual-tone, triad, bell, sonar ping, and 6 metallic piezo 500ms chimes — all mastered at comfortable -6 dB with fine volume control (`1%–100%`, 1% steps up to 20% and 5% steps above 20%, default 10%) and automatic system volume restore.
  - **Vibration:** 7 haptic patterns (`2x Short`, `2x Crown`, `3x Fast`, `Short+Long`, `Long+Short`, `1x Single`, `System 2x`) with 3 strength levels (`Light`, `Medium`, `Strong`).
- **Independent Silent Mode & Off-Wrist Controls (`DND / Sleep / Theater` + `Wear`):**
  - Reads `@zos/settings` (`getSystemMode()`) for Do Not Disturb, Sleep Mode, and Theater Mode.
  - Two separate toggles: **`Mute Audio`** (Buzzer & Speaker) and **`Mute Vibr.`** (Vibration) — allowing you to silence sounds while optionally keeping subtle wrist vibrations.
  - **`Mute off-wrist`** (`@zos/sensor` `Wear`): optionally silences chimes whenever the watch is taken off your wrist (e.g. on a desk or charger).
- **Flexible Active Hours, Days of Week & Automatic 12H/24H Time Format:**
  - 24/7 mode or custom hourly range (`FROM` / `TO`, including overnight ranges).
  - Day-of-week schedule: **`Every Day`**, **`Mon–Fri` (Weekdays)**, or **`Sat–Sun` (Weekends)** — automatically jumps entire inactive days/weekends with **0 RTC wakeups**.
  - Automatically displays `24H` (`08:00`–`22:00`) or `12H AM/PM` (`8:00 AM`–`10:00 PM`) based on your watch system clock setting.
- **Universal Round & Square UI + 34 Official Zepp OS Languages:**
  - Adapts automatically to round (`360×360`–`480×480`) and square (`320×380`–`432×514`) displays across `NXP`, `ZPS`, and `APOLLO` chipsets.
  - Full UI & launcher localization across all 34 Zepp OS languages (`en-US`, `pl-PL`, `de-DE`, `fr-FR`, `es-ES`, `it-IT`, `pt-PT`, `pt-BR`, `nl-NL`, `ru-RU`, `uk-UA`, `cs-CZ`, `sk-SK`, `hu-HU`, `ro-RO`, `tr-TR`, `el-GR`, `sv-SE`, `nb-NO`, `da-DK`, `fi-FI`, `sr-RS`, `ca-ES`, `zh-CN`, `zh-TW`, `ja-JP`, `ko-KR`, `id-ID`, `ms-MY`, `vi-VN`, `th-TH`, `ar-EG`, `iw-IL`, `hi-IN`).
- **100% Offline & Private:** No companion phone script, no network calls, no telemetry. See [PRIVACY.md](PRIVACY.md).

## Project Structure

- `app.js` — Lightweight app entry point (schedule sync and cleanup happen directly in the page bundle)
- `service/hourly_chime.js` — Zero-polling AppService woken exclusively by `@zos/alarm` (pure Single Execution for atomic chimes; dormant zero-CPU listener for async MP3s and custom buzzer repeat gaps)
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
