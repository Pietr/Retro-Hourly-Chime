import { readFileSync, writeFileSync, rmSync, renameSync, statSync } from '@zos/fs'
import { LocalStorage } from '@zos/storage'
import { log as Logger } from '@zos/utils'
import {
  BUZZER_REPEAT_COUNTS,
  BUZZER_VARIANT_IDS,
  DEFAULT_CONFIG,
  DEFAULT_RUNTIME,
  SPEAKER_VARIANT_IDS,
  VIBRATE_MODE_IDS
} from './constants'

const logger = Logger.getLogger('hourly_chime_storage')
const SETTINGS_FILE = 'user_settings_v1.json'
const RUNTIME_FILE = 'runtime_state_v1.json'
const FALLBACK_SETTINGS_KEY = 'hrc_user_settings_v1'

let cachedLocalStorage = null
let pendingSaveTimer = null
let pendingSaveConfig = null

function getLocalStorage() {
  if (cachedLocalStorage) {
    return cachedLocalStorage
  }
  try {
    cachedLocalStorage = new LocalStorage()
  } catch (e) {
    cachedLocalStorage = null
  }
  return cachedLocalStorage
}

function clampInt(value, min, max, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num)) {
    return fallback
  }
  const floored = Math.floor(num)
  if (floored < min || floored > max) {
    return Math.max(min, Math.min(max, floored))
  }
  return floored
}

function toBool(value, fallback) {
  if (typeof value === 'boolean') {
    return value
  }
  return fallback
}

function normalizeConfig(rawObj) {
  const src = rawObj && typeof rawObj === 'object' ? rawObj : {}
  const buzzerVariant =
    BUZZER_VARIANT_IDS.indexOf(src.buzzerVariant) !== -1
      ? src.buzzerVariant
      : DEFAULT_CONFIG.buzzerVariant
  const speakerVariant =
    SPEAKER_VARIANT_IDS.indexOf(src.speakerVariant) !== -1
      ? src.speakerVariant
      : DEFAULT_CONFIG.speakerVariant
  const vibrateMode =
    VIBRATE_MODE_IDS.indexOf(src.vibrateMode) !== -1
      ? src.vibrateMode
      : DEFAULT_CONFIG.vibrateMode

  return {
    enabled: toBool(src.enabled, DEFAULT_CONFIG.enabled),
    buzzerEnabled: toBool(src.buzzerEnabled, DEFAULT_CONFIG.buzzerEnabled),
    speakerEnabled: toBool(src.speakerEnabled, DEFAULT_CONFIG.speakerEnabled),
    vibrateEnabled: toBool(src.vibrateEnabled, DEFAULT_CONFIG.vibrateEnabled),
    buzzerVariant,
    buzzerRepeats: clampInt(
      src.buzzerRepeats,
      0,
      BUZZER_REPEAT_COUNTS.length - 1,
      DEFAULT_CONFIG.buzzerRepeats
    ),
    speakerVariant,
    speakerVolume: clampInt(src.speakerVolume, 10, 100, DEFAULT_CONFIG.speakerVolume),
    vibrateMode,
    vibrateStrength: clampInt(src.vibrateStrength, 0, 2, DEFAULT_CONFIG.vibrateStrength),
    allDay: toBool(src.allDay, DEFAULT_CONFIG.allDay),
    startHour: clampInt(src.startHour, 0, 23, DEFAULT_CONFIG.startHour),
    endHour: clampInt(src.endHour, 0, 23, DEFAULT_CONFIG.endHour),
    respectDndSound: toBool(src.respectDndSound, DEFAULT_CONFIG.respectDndSound),
    respectDndVibrate: toBool(src.respectDndVibrate, DEFAULT_CONFIG.respectDndVibrate)
  }
}

export function hasAnyActiveChannel(cfg, caps) {
  if (!cfg) return false
  const hasBuzzer = caps && typeof caps === 'object' ? Boolean(caps.hasBuzzer) : Boolean(caps)
  const hasSpeaker = caps && typeof caps === 'object' ? Boolean(caps.hasSpeaker) : true
  const hasVibrator = caps && typeof caps === 'object' ? Boolean(caps.hasVibrator) : true
  return Boolean(
    (hasBuzzer && cfg.buzzerEnabled) ||
      (hasSpeaker && cfg.speakerEnabled) ||
      (hasVibrator && cfg.vibrateEnabled)
  )
}

function safeReadJsonFile(filePath) {
  try {
    if (typeof statSync === 'function') {
      const info = statSync({ path: filePath })
      if (!info || info.size <= 0) {
        return null
      }
    }
    const raw = readFileSync({
      path: filePath,
      options: { encoding: 'utf8' }
    })
    if (typeof raw === 'string' && raw.length > 0) {
      const cleaned = raw.replace(/\0+$/g, '').trim()
      if (cleaned.length > 0) {
        return JSON.parse(cleaned)
      }
    }
  } catch (e) {
    logger.warn('safeReadJsonFile failed for', filePath, e)
  }
  return null
}

function safeWriteJsonFile(filePath, obj) {
  const serialized = JSON.stringify(obj)
  const tmpPath = `${filePath}.tmp`

  // Preferred: atomic write to temporary file followed by renameSync
  try {
    try {
      rmSync({ path: tmpPath })
    } catch (e) {}

    writeFileSync({
      path: tmpPath,
      data: serialized,
      options: { encoding: 'utf8' }
    })

    if (typeof renameSync === 'function') {
      const res = renameSync({ oldPath: tmpPath, newPath: filePath })
      if (res === 0) {
        return true
      }
    }
  } catch (e) {}

  // Fallback for filesystems where renameSync cannot overwrite an existing target
  try {
    try {
      rmSync({ path: tmpPath })
    } catch (e) {}
    try {
      rmSync({ path: filePath })
    } catch (e) {}

    writeFileSync({
      path: filePath,
      data: serialized,
      options: { encoding: 'utf8' }
    })
    return true
  } catch (e) {
    logger.error('safeWriteJsonFile failed for', filePath, e)
    return false
  }
}

/**
 * Load user settings fresh from flash disk (AppService only reads this file, never writes it).
 */
export function loadConfig() {
  const parsed = safeReadJsonFile(SETTINGS_FILE)
  if (parsed && typeof parsed === 'object') {
    return normalizeConfig(parsed)
  }

  try {
    const ls = getLocalStorage()
    if (ls) {
      const raw = ls.getItem(FALLBACK_SETTINGS_KEY)
      if (raw) {
        const lsParsed = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (lsParsed && typeof lsParsed === 'object') {
          return normalizeConfig(lsParsed)
        }
      }
    }
  } catch (e) {
    logger.error('LocalStorage fallback load failed:', e)
  }

  return normalizeConfig(DEFAULT_CONFIG)
}

/**
 * Immediately persist user settings to flash + LocalStorage mirror.
 */
function saveConfig(config) {
  if (pendingSaveTimer !== null) {
    try {
      clearTimeout(pendingSaveTimer)
    } catch (e) {}
    pendingSaveTimer = null
  }
  pendingSaveConfig = null

  const merged = normalizeConfig(config)
  const okFs = safeWriteJsonFile(SETTINGS_FILE, merged)

  let okLs = false
  try {
    const ls = getLocalStorage()
    if (ls) {
      ls.setItem(FALLBACK_SETTINGS_KEY, JSON.stringify(merged))
      okLs = true
    }
  } catch (e) {
    logger.warn('LocalStorage mirror write failed:', e)
  }

  return okFs || okLs
}

/**
 * Debounced settings persistence for rapid UI clicks (flushed automatically on Page/App destroy).
 */
function saveConfigDebounced(config, delayMs = 350) {
  pendingSaveConfig = normalizeConfig(config)
  if (pendingSaveTimer !== null) {
    try {
      clearTimeout(pendingSaveTimer)
    } catch (e) {}
  }
  pendingSaveTimer = setTimeout(() => {
    pendingSaveTimer = null
    const toSave = pendingSaveConfig
    pendingSaveConfig = null
    if (toSave) {
      saveConfig(toSave)
    }
  }, delayMs)
}

export function flushPendingConfigSave() {
  if (pendingSaveTimer !== null) {
    try {
      clearTimeout(pendingSaveTimer)
    } catch (e) {}
    pendingSaveTimer = null
  }
  if (pendingSaveConfig) {
    const toSave = pendingSaveConfig
    pendingSaveConfig = null
    saveConfig(toSave)
    return true
  }
  return false
}

export function updateConfig(partial, baseConfig = null, immediate = true) {
  const current = baseConfig ? normalizeConfig(baseConfig) : loadConfig()
  const updated = normalizeConfig({
    ...current,
    ...partial
  })
  if (immediate) {
    saveConfig(updated)
  } else {
    saveConfigDebounced(updated)
  }
  return updated
}

/**
 * Separate runtime state file (lastChimedKey + lastBgLog) written only by AppService
 * so background activity never touches user_settings_v1.json.
 */
export function loadRuntimeState() {
  const parsed = safeReadJsonFile(RUNTIME_FILE)
  if (parsed && typeof parsed === 'object') {
    return {
      ...DEFAULT_RUNTIME,
      ...parsed
    }
  }
  return { ...DEFAULT_RUNTIME }
}

export function updateRuntimeState(partial) {
  const current = loadRuntimeState()
  const updated = {
    ...current,
    ...partial
  }
  safeWriteJsonFile(RUNTIME_FILE, updated)
  return updated
}
