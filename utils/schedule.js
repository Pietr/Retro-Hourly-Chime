import { Time, Wear, checkSensor, TIME_HOUR_FORMAT_12 } from '@zos/sensor'
import { getSystemMode, getTimeFormat, TIME_FORMAT_12 } from '@zos/settings'
import {
  set as setAlarm,
  cancel as cancelAlarm,
  getAllAlarms,
  REPEAT_HOUR,
  REPEAT_ONCE
} from '@zos/alarm'
import * as appService from '@zos/app-service'
import { queryPermission, requestPermission } from '@zos/app'
import { log as Logger } from '@zos/utils'
import { SERVICE_FILE } from './constants'
import {
  hasAnyActiveChannel,
  loadConfig,
  loadRuntimeState,
  updateRuntimeState
} from './storage'
import {
  getBuzzerRepeatCount,
  getHardwareCapabilities,
  playHourlyChime
} from './audio'

const logger = Logger.getLogger('hourly_chime_sched')

let cachedTimeSensor = null
let activeTestAlarmId = 0
let lastTestFiredTs = 0

function getTimeSensor() {
  if (cachedTimeSensor) {
    return cachedTimeSensor
  }
  try {
    if (typeof Time === 'function') {
      cachedTimeSensor = new Time()
    }
  } catch (e) {
    cachedTimeSensor = null
  }
  return cachedTimeSensor
}

function jsDateToIsoDay(d) {
  const jsDay = d.getDay() // 0 = Sun, 1 = Mon .. 6 = Sat
  return jsDay === 0 ? 7 : jsDay
}

/**
 * Read current local watch time from native @zos/sensor Time (immune to QuickJS TZ/DST drift),
 * falling back to JS Date if unavailable.
 * isoDay is always normalized to 1..7 (1 = Monday .. 7 = Sunday).
 */
function getNowParts() {
  try {
    const ts = getTimeSensor()
    if (ts) {
      const year = ts.getFullYear()
      const month = ts.getMonth() // 1..12
      const day = ts.getDate()
      const hour = ts.getHours()
      const minute = ts.getMinutes()
      const second = ts.getSeconds()
      const rawDay = typeof ts.getDay === 'function' ? ts.getDay() : 0 // Zepp OS Time: 1=Mon..7=Sun
      const isoDay =
        rawDay >= 1 && rawDay <= 7
          ? rawDay
          : jsDateToIsoDay(new Date(year, month - 1, day))
      const utcMs = typeof ts.getTime === 'function' ? ts.getTime() : Date.now()
      if (Number.isFinite(hour) && Number.isFinite(minute) && Number.isFinite(second)) {
        return { year, month, day, isoDay, hour, minute, second, utcMs }
      }
    }
  } catch (e) {}

  const d = new Date()
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    isoDay: jsDateToIsoDay(d),
    hour: d.getHours(),
    minute: d.getMinutes(),
    second: d.getSeconds(),
    utcMs: d.getTime()
  }
}

/**
 * Inspect watch system silent modes (Do Not Disturb, Sleep, Theater).
 */
export function getSystemSilentMode() {
  try {
    if (typeof getSystemMode === 'function') {
      const mode = getSystemMode() || {}
      const dnd = Boolean(mode.DND)
      const sleep = Boolean(mode.sleep)
      const theater = Boolean(mode.theater)
      const tags = []
      if (dnd) tags.push('DND')
      if (sleep) tags.push('SLP')
      if (theater) tags.push('THT')
      return {
        dnd,
        sleep,
        theater,
        isQuiet: dnd || sleep || theater,
        tag: tags.join('+')
      }
    }
  } catch (e) {}
  return { dnd: false, sleep: false, theater: false, isQuiet: false, tag: '' }
}

/**
 * Returns true ONLY when the Wear sensor explicitly confirms status === 0 (not wearing).
 * Returns false if wearing (1), in motion (2), unsure (3), or sensor unavailable.
 */
function isWatchOffWrist() {
  try {
    if (typeof Wear !== 'function') {
      return false
    }
    if (typeof checkSensor === 'function' && !checkSensor(Wear)) {
      return false
    }
    const wear = new Wear()
    if (wear && typeof wear.getStatus === 'function') {
      return wear.getStatus() === 0
    }
  } catch (e) {}
  return false
}

function isDayActive(isoDay, config) {
  const cfg = config || loadConfig()
  const mode = cfg.daysMode || 'everyday'
  if (mode === 'weekdays') {
    return isoDay >= 1 && isoDay <= 5
  }
  if (mode === 'weekends') {
    return isoDay === 6 || isoDay === 7
  }
  return true
}

function isHourActive(hour, config) {
  const cfg = config || loadConfig()
  if (!cfg.enabled) {
    return false
  }
  if (cfg.allDay) {
    return true
  }
  const start = Number(cfg.startHour)
  const end = Number(cfg.endHour)
  const h = Number(hour)
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(h)) {
    return false
  }
  if (start <= end) {
    return h >= start && h <= end
  }
  return h >= start || h <= end
}

/**
 * Detect whether the watch system clock is currently set to 12-hour (AM/PM) format.
 */
export function is12HourFormat() {
  try {
    if (typeof getTimeFormat === 'function' && TIME_FORMAT_12 !== undefined) {
      return getTimeFormat() === TIME_FORMAT_12
    }
  } catch (e) {}
  try {
    const ts = getTimeSensor()
    if (ts && typeof ts.getHourFormat === 'function' && TIME_HOUR_FORMAT_12 !== undefined) {
      return ts.getHourFormat() === TIME_HOUR_FORMAT_12
    }
  } catch (e) {}
  return false
}

export function formatHour(hour) {
  const num = Number(hour)
  const safe = Number.isFinite(num) ? Math.floor(num) : 0
  const h = ((safe % 24) + 24) % 24
  if (is12HourFormat()) {
    const suffix = h < 12 ? 'AM' : 'PM'
    const h12 = h % 12 === 0 ? 12 : h % 12
    return `${h12}:00 ${suffix}`
  }
  return (h < 10 ? '0' : '') + h + ':00'
}

/**
 * Search up to 168 hours (7 full days) ahead for the next active (day, hour) slot.
 */
function findNextActiveSlot(baseIsoDay, baseHour, cfg) {
  for (let offset = 1; offset <= 168; offset++) {
    const totalHours = baseHour + offset
    const dayDelta = Math.floor(totalHours / 24)
    const candidateHour = totalHours % 24
    const candidateIsoDay = ((baseIsoDay - 1 + dayDelta) % 7) + 1
    if (isDayActive(candidateIsoDay, cfg) && isHourActive(candidateHour, cfg)) {
      return { offset, hour: candidateHour, isoDay: candidateIsoDay, dayDelta }
    }
  }
  return null
}

/**
 * Format next scheduled chime for UI status bar (includes short day prefix when jumping across days).
 */
export function getNextChimeLabel(config, dayLabels = null) {
  const cfg = config || loadConfig()
  if (!cfg.enabled || !hasAnyActiveChannel(cfg, getHardwareCapabilities())) {
    return '--:--'
  }
  const now = getNowParts()
  const next = findNextActiveSlot(now.isoDay, now.hour, cfg)
  if (!next) {
    return '--:--'
  }
  const hourStr = formatHour(next.hour)
  const jumpsDays =
    next.dayDelta > 1 ||
    (next.dayDelta === 1 && cfg.daysMode !== 'everyday' && !isDayActive(now.isoDay, cfg))
  if (jumpsDays && dayLabels && dayLabels[next.isoDay]) {
    return `${dayLabels[next.isoDay]} ${hourStr}`
  }
  return hourStr
}

/**
 * Returns true if the active configuration requires async timer/media execution in background
 * (Speaker MP3s or custom Buzzer repeat gap 50..750 ms).
 * Pure atomic chimes (native Buzzer Auto + Vibrator) run in zero-RAM Single Execution mode!
 */
export function needsAsyncBackgroundService(cfg, capsOverride = null) {
  if (!cfg || !cfg.enabled) return false
  const caps = capsOverride || getHardwareCapabilities()
  const needsSpeaker = Boolean(cfg.speakerEnabled && caps.hasSpeaker)
  const needsBuzzerGap = Boolean(
    cfg.buzzerEnabled &&
      caps.hasBuzzer &&
      getBuzzerRepeatCount(cfg.buzzerRepeats) > 0 &&
      Number(cfg.buzzerGapMs) > 0
  )
  return needsSpeaker || needsBuzzerGap
}

function clearAllScheduledAlarms(preserveTestAlarm = false) {
  try {
    if (typeof getAllAlarms === 'function') {
      const alarms = getAllAlarms() || []
      for (let i = 0; i < alarms.length; i++) {
        if (preserveTestAlarm && activeTestAlarmId && alarms[i] === activeTestAlarmId) {
          continue
        }
        try {
          cancelAlarm(alarms[i])
        } catch (e) {}
      }
    }
    if (!preserveTestAlarm) {
      activeTestAlarmId = 0
    }
  } catch (e) {
    logger.error('Failed to clear existing alarms:', e)
  }
}

function isServiceRunning() {
  try {
    if (appService && typeof appService.getAllAppServices === 'function') {
      const list = appService.getAllAppServices() || []
      for (let i = 0; i < list.length; i++) {
        if (String(list[i]).indexOf(SERVICE_FILE) !== -1) {
          return true
        }
      }
    }
  } catch (e) {}
  return false
}

/**
 * Prompt once for device:os.bg_service permission while UI is open (only needed for async
 * Speaker MP3 chimes or custom Buzzer repeat gaps).
 */
export function ensureBackgroundPermission(onDone) {
  try {
    const perms = ['device:os.bg_service']
    const status =
      typeof queryPermission === 'function' ? queryPermission({ permissions: perms }) : [2]
    if (status && status[0] === 2) {
      if (onDone) onDone(true)
      return
    }
    if (typeof requestPermission === 'function') {
      requestPermission({
        permissions: perms,
        callback: (res) => {
          if (onDone) onDone(Boolean(res && res[0] === 2))
        }
      })
      return
    }
  } catch (e) {}
  if (onDone) onDone(true)
}

function hasBgServicePermission() {
  try {
    if (typeof queryPermission === 'function') {
      const status = queryPermission({ permissions: ['device:os.bg_service'] })
      return Boolean(status && status[0] === 2)
    }
  } catch (e) {}
  return true
}

/**
 * Pause any running AppService while foreground UI is open so UI holds exclusive hardware access.
 */
export function stopLegacyContinuousService() {
  try {
    if (isServiceRunning() && typeof appService.stop === 'function') {
      appService.stop({
        file: SERVICE_FILE,
        complete_func: () => {}
      })
      return true
    }
  } catch (e) {}
  return false
}

/**
 * Called ONCE when UI Page exits (Page.onDestroy):
 * - If config only uses atomic channels (Buzzer Auto / Vibrator): keeps 0 background services running
 *   (pure Single Execution woken by @zos/alarm, 0 B RAM between hours!).
 * - If config uses Speaker MP3 or custom Buzzer gap (50..750 ms): starts dormant service/hourly_chime
 *   with ZERO timers and ZERO onPerMinute (0% idle CPU — woken exclusively by @zos/alarm) so async
 *   timers and @zos/media Player complete cleanly without Single Execution 600ms teardown.
 */
export function finalizeBackgroundServiceOnPageExit(config) {
  const cfg = config || loadConfig()
  const caps = getHardwareCapabilities()

  if (!cfg.enabled || !hasAnyActiveChannel(cfg, caps) || !needsAsyncBackgroundService(cfg, caps)) {
    stopLegacyContinuousService()
    return false
  }

  if (isServiceRunning()) {
    return true
  }

  if (!hasBgServicePermission()) {
    return false
  }

  try {
    if (appService && typeof appService.start === 'function') {
      appService.start({
        file: SERVICE_FILE,
        param: 'idle_ready',
        reload: true,
        complete_func: () => {}
      })
      return true
    }
  } catch (e) {
    logger.error('Failed to start dormant async AppService:', e)
  }
  return false
}

/**
 * Schedule ONE persistent hardware RTC alarm (@zos/alarm) pointing directly to the next active
 * (day, hour) slot. Jumps over both quiet overnight windows and inactive days (e.g. entire weekends
 * with 0 wakeups) while keeping REPEAT_HOUR as a self-healing hourly cadence during active windows.
 */
function scheduleNextActiveAlarm(config, snapEarlyJitter = false, preserveTestAlarm = false) {
  clearAllScheduledAlarms(preserveTestAlarm)
  const cfg = config || loadConfig()

  if (!cfg.enabled || !hasAnyActiveChannel(cfg, getHardwareCapabilities())) {
    return { ok: true, alarmId: 0, active: false }
  }

  try {
    const now = getNowParts()
    const isEarlySnap = snapEarlyJitter && now.minute === 59 && now.second >= 55
    let delaySec = 0

    if (isEarlySnap) {
      const snapped = new Date(
        now.year,
        now.month - 1,
        now.day,
        now.hour,
        now.minute,
        now.second + 10
      )
      const baseHour = snapped.getHours()
      const baseIsoDay = jsDateToIsoDay(snapped)
      const next = findNextActiveSlot(baseIsoDay, baseHour, cfg)
      if (!next) {
        return { ok: true, alarmId: 0, active: false }
      }
      delaySec = Math.max(1, 60 - now.second) + next.offset * 3600
    } else {
      const next = findNextActiveSlot(now.isoDay, now.hour, cfg)
      if (!next) {
        return { ok: true, alarmId: 0, active: false }
      }
      const secsToNextHour = (59 - now.minute) * 60 + (60 - now.second)
      delaySec = Math.max(10, secsToNextHour + (next.offset - 1) * 3600)
    }

    const nowUtcSec = Math.floor(now.utcMs / 1000)
    let alarmId = 0

    if (Number.isFinite(nowUtcSec) && nowUtcSec > 1000000000) {
      alarmId = setAlarm({
        url: SERVICE_FILE,
        time: nowUtcSec + delaySec,
        repeat_type: REPEAT_HOUR,
        repeat_period: 1,
        repeat_duration: 1,
        store: true,
        param: 'alarm_wakeup'
      })
    }

    if (!alarmId) {
      alarmId = setAlarm({
        url: SERVICE_FILE,
        delay: delaySec,
        repeat_type: REPEAT_HOUR,
        repeat_period: 1,
        repeat_duration: 1,
        store: true,
        param: 'alarm_wakeup'
      })
    }

    return { ok: Boolean(alarmId), alarmId: alarmId || 0, active: true }
  } catch (e) {
    logger.error('Failed to schedule alarm:', e)
    return { ok: false, alarmId: 0, active: true }
  }
}

/**
 * Schedule a safe one-shot 15-second background test alarm without replacing the hourly schedule.
 */
export function scheduleTestAlarm15s() {
  try {
    if (activeTestAlarmId) {
      try {
        cancelAlarm(activeTestAlarmId)
      } catch (e) {}
      activeTestAlarmId = 0
    }
    const alarmId = setAlarm({
      url: SERVICE_FILE,
      delay: 15,
      repeat_type: REPEAT_ONCE,
      store: false,
      param: 'test_wakeup'
    })
    activeTestAlarmId = alarmId || 0
    return Boolean(alarmId)
  } catch (e) {
    logger.error('scheduleTestAlarm15s failed:', e)
    return false
  }
}

/**
 * Synchronize hardware RTC alarm schedule (called from UI).
 */
export function syncBackgroundSchedule(config, preserveTestAlarm = false) {
  const cfg = config || loadConfig()
  if (!cfg.enabled || !hasAnyActiveChannel(cfg, getHardwareCapabilities())) {
    clearAllScheduledAlarms(preserveTestAlarm)
    stopLegacyContinuousService()
    return { ok: true, alarmId: 0, active: false }
  }
  return scheduleNextActiveAlarm(cfg, false, preserveTestAlarm)
}

export function getBackgroundDiagnostics() {
  let svcCount = 0
  let almCount = 0
  try {
    if (appService && typeof appService.getAllAppServices === 'function') {
      const list = appService.getAllAppServices() || []
      svcCount = list.length
    }
  } catch (e) {}
  try {
    if (typeof getAllAlarms === 'function') {
      const list = getAllAlarms() || []
      almCount = list.length
    }
  } catch (e) {}
  return `SVC:${svcCount} ALM:${almCount}`
}

/**
 * AppService wakeup handler triggered exclusively by @zos/alarm ('alarm_wakeup' / 'test_wakeup').
 * Ignores 'idle_ready' / reboot init with zero timers and zero CPU activity!
 */
export function handleBackgroundWakeup(params) {
  const isAlarm = params === 'alarm_wakeup'
  const isTest = params === 'test_wakeup'

  // Dormant startup ('idle_ready' or system reload): do NOTHING — 0 sensors, 0 timers, 0 flash I/O
  if (!isAlarm && !isTest) {
    return
  }

  // Guard against duplicate delivery if firmware fires both onInit and onEvent for the same test alarm
  if (isTest) {
    const nowTs = Date.now()
    if (nowTs - lastTestFiredTs < 2500) {
      return
    }
    lastTestFiredTs = nowTs
  }

  const cfg = loadConfig()
  const now = getNowParts()

  if (!isTest && (!cfg.enabled || !hasAnyActiveChannel(cfg, getHardwareCapabilities()))) {
    clearAllScheduledAlarms()
    return
  }

  const offWristMuted = Boolean(cfg.muteOffWrist && isWatchOffWrist())
  const silent = getSystemSilentMode()
  const allowSound = !offWristMuted && !(silent.isQuiet && cfg.respectDndSound)
  const allowVibrate = !offWristMuted && !(silent.isQuiet && cfg.respectDndVibrate)
  const muteReasonTag = offWristMuted ? 'OFF-WRIST' : silent.isQuiet ? silent.tag : ''

  if (isTest) {
    const hh = (now.hour < 10 ? '0' : '') + now.hour
    const mm = (now.minute < 10 ? '0' : '') + now.minute
    executeChimeWithLog(cfg, hh, mm, 'TST15', muteReasonTag, allowSound, allowVibrate, null)
    return
  }

  // Tolerate slight RTC wakeup jitter: early XX:59:55..59:59 or late XX:00:00..XX:02:59
  let logicalYear = now.year
  let logicalMonth = now.month
  let logicalDay = now.day
  let logicalIsoDay = now.isoDay
  let logicalHour = now.hour
  let isEarlySnap = false

  if (now.minute === 59 && now.second >= 55) {
    isEarlySnap = true
    const snapped = new Date(
      now.year,
      now.month - 1,
      now.day,
      now.hour,
      now.minute,
      now.second + 10
    )
    logicalYear = snapped.getFullYear()
    logicalMonth = snapped.getMonth() + 1
    logicalDay = snapped.getDate()
    logicalIsoDay = jsDateToIsoDay(snapped)
    logicalHour = snapped.getHours()
  } else if (now.minute > 2) {
    scheduleNextActiveAlarm(cfg, false)
    return
  }

  // Check if the very next hour after logicalHour is inactive (night or inactive day) -> jump directly
  const nextTotalHour = logicalHour + 1
  const nextHour = nextTotalHour % 24
  const nextIsoDay = nextTotalHour >= 24 ? (logicalIsoDay % 7) + 1 : logicalIsoDay
  if (!isDayActive(nextIsoDay, cfg) || !isHourActive(nextHour, cfg)) {
    scheduleNextActiveAlarm(cfg, isEarlySnap)
  }

  if (!isDayActive(logicalIsoDay, cfg) || !isHourActive(logicalHour, cfg)) {
    return
  }

  const dedupKey = `${logicalYear}-${logicalMonth}-${logicalDay}-${logicalHour}`
  const runtime = loadRuntimeState()
  if (runtime.lastChimedKey === dedupKey) {
    return
  }

  const hh = (logicalHour < 10 ? '0' : '') + logicalHour
  const mm = isEarlySnap ? '00' : (now.minute < 10 ? '0' : '') + now.minute

  executeChimeWithLog(cfg, hh, mm, 'ALM', muteReasonTag, allowSound, allowVibrate, dedupKey)
}

function executeChimeWithLog(
  cfg,
  hh,
  mm,
  sourceTag,
  muteReasonTag,
  allowSound,
  allowVibrate,
  dedupKey
) {
  const caps = getHardwareCapabilities()
  const parts = []
  const runBuzzer = cfg.buzzerEnabled && allowSound && caps.hasBuzzer
  const runSpeaker = cfg.speakerEnabled && allowSound && caps.hasSpeaker
  const runVibrate = cfg.vibrateEnabled && allowVibrate && caps.hasVibrator

  if (runBuzzer) {
    const gapSuffix = cfg.buzzerGapMs > 0 ? `@${cfg.buzzerGapMs}ms` : ''
    parts.push(`B:${cfg.buzzerVariant}x${getBuzzerRepeatCount(cfg.buzzerRepeats) + 1}${gapSuffix}`)
  }
  if (runSpeaker) {
    parts.push(`S:${cfg.speakerVariant}@${cfg.speakerVolume}%`)
  }
  if (runVibrate) {
    parts.push(`V:${cfg.vibrateMode}@${cfg.vibrateStrength}`)
  }

  const suffix = muteReasonTag ? ` (${muteReasonTag})` : ''
  const summary = parts.length > 0 ? `${parts.join(' ')}${suffix}` : `MUTED${suffix}`
  const patch = {
    lastBgLog: `${hh}:${mm} [${sourceTag}] ${summary}`
  }
  if (dedupKey) {
    patch.lastChimedKey = dedupKey
  }
  updateRuntimeState(patch)

  if (!runBuzzer && !runSpeaker && !runVibrate) {
    return
  }

  playHourlyChime(cfg, {
    isBackground: true,
    allowSound,
    allowVibrate
  })
}
