import { Time, TIME_HOUR_FORMAT_12 } from '@zos/sensor'
import { getSystemMode, getTimeFormat, TIME_FORMAT_12 } from '@zos/settings'
import {
  set as setAlarm,
  cancel as cancelAlarm,
  getAllAlarms,
  REPEAT_HOUR,
  REPEAT_ONCE
} from '@zos/alarm'
import * as appService from '@zos/app-service'
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

/**
 * Read current local watch time from native @zos/sensor Time (immune to QuickJS TZ/DST drift),
 * falling back to JS Date if unavailable.
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
      const utcMs = typeof ts.getTime === 'function' ? ts.getTime() : Date.now()
      if (Number.isFinite(hour) && Number.isFinite(minute) && Number.isFinite(second)) {
        return { year, month, day, hour, minute, second, utcMs }
      }
    }
  } catch (e) {}

  const d = new Date()
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
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

function findNextActiveOffsetHours(baseHour, cfg) {
  for (let offset = 1; offset <= 24; offset++) {
    const candidateHour = (baseHour + offset) % 24
    if (isHourActive(candidateHour, cfg)) {
      return offset
    }
  }
  return 0
}

export function getNextChimeLabel(config) {
  const cfg = config || loadConfig()
  if (!cfg.enabled || !hasAnyActiveChannel(cfg, getHardwareCapabilities())) {
    return '--:--'
  }
  const now = getNowParts()
  const offset = findNextActiveOffsetHours(now.hour, cfg)
  if (offset <= 0) {
    return '--:--'
  }
  return formatHour((now.hour + offset) % 24)
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

/**
 * Stop any leftover continuous AppService from older app versions (v2.2.0 and earlier).
 */
export function stopLegacyContinuousService() {
  try {
    if (appService && typeof appService.getAllAppServices === 'function') {
      const list = appService.getAllAppServices() || []
      for (let i = 0; i < list.length; i++) {
        if (String(list[i]).indexOf(SERVICE_FILE) !== -1) {
          if (typeof appService.stop === 'function') {
            appService.stop({
              file: SERVICE_FILE,
              complete_func: () => {}
            })
          }
          return true
        }
      }
    }
  } catch (e) {}
  return false
}

/**
 * Schedule ONE persistent hardware RTC alarm (@zos/alarm) pointing directly to the next active hour.
 * Jumps over overnight silent windows (0 wakeups during inactive hours) while keeping REPEAT_HOUR
 * as a self-healing hourly cadence during active windows.
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
    let baseHour = now.hour
    let delaySec = 0

    if (isEarlySnap) {
      baseHour = (now.hour + 1) % 24
      const offsetHours = findNextActiveOffsetHours(baseHour, cfg)
      if (offsetHours <= 0) {
        return { ok: true, alarmId: 0, active: false }
      }
      delaySec = Math.max(1, 60 - now.second) + offsetHours * 3600
    } else {
      const offsetHours = findNextActiveOffsetHours(baseHour, cfg)
      if (offsetHours <= 0) {
        return { ok: true, alarmId: 0, active: false }
      }
      const secsToNextHour = (59 - now.minute) * 60 + (60 - now.second)
      delaySec = Math.max(10, secsToNextHour + (offsetHours - 1) * 3600)
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
 * Synchronize Single Execution background schedule (RTC alarm only — zero continuous RAM usage).
 */
export function syncBackgroundSchedule(config, preserveTestAlarm = false) {
  const cfg = config || loadConfig()
  stopLegacyContinuousService()
  if (!cfg.enabled || !hasAnyActiveChannel(cfg, getHardwareCapabilities())) {
    clearAllScheduledAlarms(preserveTestAlarm)
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
 * Single Execution AppService entry handler woken by @zos/alarm.
 * Evaluates time window, deduplication, and independent DND/Sleep/Theater rules for audio vs vibration,
 * triggers allowed channels, jumps overnight silent windows, and invokes onComplete() so the service exits.
 */
export function handleBackgroundWakeup(params, onComplete) {
  const finish = () => {
    if (typeof onComplete === 'function') {
      onComplete()
    }
  }

  const cfg = loadConfig()
  const now = getNowParts()
  const isTest = params === 'test_wakeup'

  if (!isTest && (!cfg.enabled || !hasAnyActiveChannel(cfg, getHardwareCapabilities()))) {
    clearAllScheduledAlarms()
    finish()
    return
  }

  const silent = getSystemSilentMode()
  const allowSound = !(silent.isQuiet && cfg.respectDndSound)
  const allowVibrate = !(silent.isQuiet && cfg.respectDndVibrate)

  if (isTest) {
    const hh = (now.hour < 10 ? '0' : '') + now.hour
    const mm = (now.minute < 10 ? '0' : '') + now.minute
    const played = executeChimeWithLog(cfg, hh, mm, 'TST15', silent, allowSound, allowVibrate, finish)
    if (!played) {
      finish()
    }
    return
  }

  // Tolerate slight RTC wakeup jitter: early XX:59:55..59:59 or late XX:00:00..XX:02:59
  let logicalYear = now.year
  let logicalMonth = now.month
  let logicalDay = now.day
  let logicalHour = now.hour
  let isEarlySnap = false

  if (now.minute === 59 && now.second >= 55) {
    isEarlySnap = true
    const snapped = new Date(now.year, now.month - 1, now.day, now.hour, now.minute, now.second + 10)
    logicalYear = snapped.getFullYear()
    logicalMonth = snapped.getMonth() + 1
    logicalDay = snapped.getDate()
    logicalHour = snapped.getHours()
  } else if (now.minute > 2) {
    // Out-of-window wakeup: re-align next active alarm and exit without chiming
    scheduleNextActiveAlarm(cfg, false)
    finish()
    return
  }

  // If the next hour after logicalHour is NOT active, reschedule alarm to jump over the silent night block
  const nextHour = (logicalHour + 1) % 24
  if (!cfg.allDay && !isHourActive(nextHour, cfg)) {
    scheduleNextActiveAlarm(cfg, isEarlySnap)
  }

  if (!isHourActive(logicalHour, cfg)) {
    finish()
    return
  }

  const dedupKey = `${logicalYear}-${logicalMonth}-${logicalDay}-${logicalHour}`
  const runtime = loadRuntimeState()
  if (runtime.lastChimedKey === dedupKey) {
    finish()
    return
  }

  const hh = (logicalHour < 10 ? '0' : '') + logicalHour
  const mm = isEarlySnap ? '00' : (now.minute < 10 ? '0' : '') + now.minute

  const played = executeChimeWithLog(
    cfg,
    hh,
    mm,
    'ALM',
    silent,
    allowSound,
    allowVibrate,
    finish,
    dedupKey
  )
  if (!played) {
    finish()
  }
}

function executeChimeWithLog(
  cfg,
  hh,
  mm,
  sourceTag,
  silent,
  allowSound,
  allowVibrate,
  onDone,
  dedupKey = null
) {
  const caps = getHardwareCapabilities()
  const parts = []
  const runBuzzer = cfg.buzzerEnabled && allowSound && caps.hasBuzzer
  const runSpeaker = cfg.speakerEnabled && allowSound && caps.hasSpeaker
  const runVibrate = cfg.vibrateEnabled && allowVibrate && caps.hasVibrator

  if (runBuzzer) {
    parts.push(`B:${cfg.buzzerVariant}x${getBuzzerRepeatCount(cfg.buzzerRepeats) + 1}`)
  }
  if (runSpeaker) {
    parts.push(`S:${cfg.speakerVariant}@${cfg.speakerVolume}%`)
  }
  if (runVibrate) {
    parts.push(`V:${cfg.vibrateMode}@${cfg.vibrateStrength}`)
  }

  const suffix = silent.isQuiet ? ` (${silent.tag})` : ''
  const summary = parts.length > 0 ? `${parts.join(' ')}${suffix}` : `MUTED${suffix}`
  const patch = {
    lastBgLog: `${hh}:${mm} [${sourceTag}] ${summary}`
  }
  if (dedupKey) {
    patch.lastChimedKey = dedupKey
  }
  updateRuntimeState(patch)

  if (!runBuzzer && !runSpeaker && !runVibrate) {
    return false
  }

  return playHourlyChime(cfg, {
    isBackground: true,
    allowSound,
    allowVibrate,
    onDone
  })
}
