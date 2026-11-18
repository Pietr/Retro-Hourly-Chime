import {
  Buzzer,
  SystemSounds,
  Vibrator,
  Wear,
  checkSensor,
  VIBRATOR_SCENE_SHORT_LIGHT,
  VIBRATOR_SCENE_SHORT_MIDDLE,
  VIBRATOR_SCENE_SHORT_STRONG,
  VIBRATOR_SCENE_DURATION,
  VIBRATOR_SCENE_NOTIFICATION
} from '@zos/sensor'
import { getDeviceInfo } from '@zos/device'
import { create as createMedia, id as mediaId } from '@zos/media'
import { log as Logger } from '@zos/utils'
import {
  BUZZER_GAP_MAX_MS,
  BUZZER_REPEAT_COUNTS,
  SPEAKER_FILE_MAP
} from './constants'

const logger = Logger.getLogger('hourly_chime_audio')

let activeTimers = []
let activeBuzzer = null
let activeSysSounds = null
let activeVibrator = null
let cachedHasBuzzer = null
let cachedHasSpeaker = null
let cachedHasVibrator = null
let cachedHasWear = null
let lastUiDiag = ''

// Persistent singleton media player during a session (released on full destroy)
let singletonPlayer = null
let playerPlayToken = 0
let playerIsPlaying = false
let playerWatchdogId = null
let pendingVolumeToApply = 10
let savedSystemVolume = null
let lastPlayerStopTs = 0
let pendingSpeakerDone = null

function hasHardwareBuzzer() {
  if (cachedHasBuzzer !== null) {
    return cachedHasBuzzer
  }
  try {
    if (typeof Buzzer !== 'function') {
      cachedHasBuzzer = false
      return false
    }
    if (typeof checkSensor === 'function') {
      cachedHasBuzzer = Boolean(checkSensor(Buzzer))
      return cachedHasBuzzer
    }
    const probe = new Buzzer()
    cachedHasBuzzer = Boolean(probe && typeof probe.start === 'function')
    return cachedHasBuzzer
  } catch (e) {
    cachedHasBuzzer = false
    return false
  }
}

/**
 * Fallback model check for Zepp OS 3.0-3.5 watches that lack a physical speaker
 * (where SystemSounds API 3.6+ is unavailable and @zos/media may exist only for BT headphones).
 */
function isKnownSpeakerlessModel() {
  try {
    const info = getDeviceInfo()
    if (!info || info.deviceName === undefined || info.deviceName === null) {
      return false
    }
    const name = String(info.deviceName).toLowerCase()
    if (
      name.indexOf('bip 5 unity') !== -1 ||
      name.indexOf('active edge') !== -1 ||
      name.indexOf('gtr mini') !== -1 ||
      name.indexOf('gts 4 mini') !== -1 ||
      name.indexOf('t-rex ultra') !== -1 ||
      name.indexOf('falcon') !== -1
    ) {
      return true
    }
    // Base Cheetah (Round/Square) lacks a speaker; Cheetah Pro has a speaker
    if (name.indexOf('cheetah') !== -1 && name.indexOf('pro') === -1) {
      return true
    }
    // Base T-Rex 3 has only a buzzer; T-Rex 3 Pro has a speaker
    if (name.indexOf('t-rex 3') !== -1 && name.indexOf('pro') === -1) {
      return true
    }
  } catch (e) {}
  return false
}

/**
 * Detect whether the watch has a physical hardware speaker capable of playing MP3/system chimes.
 * 1. Exclude known Amazfit models that physically lack a speaker (buzzer-only or vibration-only).
 * 2. Check @zos/media Player availability (primary engine for our 18 MP3 speaker chimes).
 * 3. Fall back to SystemSounds sensor availability if @zos/media is absent.
 * Note: Do NOT gate @zos/media on checkSensor(SystemSounds), as some speaker-equipped watches
 * (e.g. Active 3 Premium) report checkSensor(SystemSounds) === false while supporting @zos/media.
 */
function hasHardwareSpeaker() {
  if (cachedHasSpeaker !== null) {
    return cachedHasSpeaker
  }
  try {
    if (isKnownSpeakerlessModel()) {
      cachedHasSpeaker = false
      return false
    }
    const hasMediaPlayer =
      typeof createMedia === 'function' && Boolean(mediaId && mediaId.PLAYER !== undefined)
    if (hasMediaPlayer) {
      cachedHasSpeaker = true
      return true
    }
    if (typeof SystemSounds === 'function') {
      if (typeof checkSensor === 'function') {
        cachedHasSpeaker = Boolean(checkSensor(SystemSounds))
        return cachedHasSpeaker
      }
      const probe = new SystemSounds()
      cachedHasSpeaker = Boolean(probe && typeof probe.start === 'function')
      return cachedHasSpeaker
    }
    cachedHasSpeaker = false
    return false
  } catch (e) {
    cachedHasSpeaker = false
    return false
  }
}

/**
 * Detect whether the watch has a hardware vibration motor.
 */
function hasHardwareVibrator() {
  if (cachedHasVibrator !== null) {
    return cachedHasVibrator
  }
  try {
    if (typeof Vibrator !== 'function') {
      cachedHasVibrator = false
      return false
    }
    if (typeof checkSensor === 'function') {
      cachedHasVibrator = Boolean(checkSensor(Vibrator))
      return cachedHasVibrator
    }
    const probe = new Vibrator()
    cachedHasVibrator = Boolean(probe && typeof probe.start === 'function')
    return cachedHasVibrator
  } catch (e) {
    cachedHasVibrator = false
    return false
  }
}

function hasHardwareWear() {
  if (cachedHasWear !== null) {
    return cachedHasWear
  }
  try {
    if (typeof Wear !== 'function') {
      cachedHasWear = false
      return false
    }
    if (typeof checkSensor === 'function') {
      cachedHasWear = Boolean(checkSensor(Wear))
      return cachedHasWear
    }
    const probe = new Wear()
    cachedHasWear = Boolean(probe && typeof probe.getStatus === 'function')
    return cachedHasWear
  } catch (e) {
    cachedHasWear = false
    return false
  }
}

export function getHardwareCapabilities() {
  return {
    hasBuzzer: hasHardwareBuzzer(),
    hasSpeaker: hasHardwareSpeaker(),
    hasVibrator: hasHardwareVibrator(),
    hasWear: hasHardwareWear()
  }
}

/**
 * Returns true if the watch's system buzzer setting (Sound & Vibration -> Buzzer -> Other)
 * is enabled, or if the API does not expose isEnabled().
 */
export function isSystemBuzzerEnabled() {
  if (!hasHardwareBuzzer()) {
    return false
  }
  try {
    if (!activeBuzzer) {
      activeBuzzer = new Buzzer()
    }
    if (activeBuzzer && typeof activeBuzzer.isEnabled === 'function') {
      return Boolean(activeBuzzer.isEnabled())
    }
  } catch (e) {}
  return true
}

export function getLastUiDiag() {
  return lastUiDiag
}

function removeTimerId(id) {
  const idx = activeTimers.indexOf(id)
  if (idx !== -1) {
    activeTimers.splice(idx, 1)
  }
}

/**
 * Schedule a tracked timer that removes its own ID before executing
 * to prevent RTOS timer ID recycling bugs.
 */
function scheduleTimer(fn, delayMs) {
  const id = setTimeout(() => {
    removeTimerId(id)
    fn()
  }, delayMs)
  activeTimers.push(id)
  return id
}

function clearWatchdog() {
  if (playerWatchdogId !== null) {
    try {
      clearTimeout(playerWatchdogId)
    } catch (e) {}
    playerWatchdogId = null
  }
}

function notifySpeakerDone() {
  const cb = pendingSpeakerDone
  pendingSpeakerDone = null
  if (typeof cb === 'function') {
    try {
      cb()
    } catch (e) {}
  }
}

function restoreSystemVolume() {
  if (savedSystemVolume !== null && singletonPlayer) {
    try {
      if (typeof singletonPlayer.setVolume === 'function') {
        singletonPlayer.setVolume(savedSystemVolume)
      }
    } catch (e) {}
    savedSystemVolume = null
  }
}

function clearPendingAudio(skipBuzzerStop = false, skipVibratorStop = false) {
  const toClear = activeTimers.slice()
  activeTimers = []
  for (let i = 0; i < toClear.length; i++) {
    try {
      clearTimeout(toClear[i])
    } catch (e) {}
  }
  clearWatchdog()
  pendingSpeakerDone = null

  if (activeBuzzer && !skipBuzzerStop) {
    try {
      activeBuzzer.stop()
    } catch (e) {}
  }
  if (activeSysSounds) {
    try {
      activeSysSounds.stop()
    } catch (e) {}
  }
  if (singletonPlayer) {
    try {
      singletonPlayer.stop()
      lastPlayerStopTs = Date.now()
    } catch (e) {}
    playerIsPlaying = false
    restoreSystemVolume()
  }
  if (activeVibrator && !skipVibratorStop) {
    try {
      activeVibrator.stop()
    } catch (e) {}
  }
}

/**
 * Fully stop and release all sensor/media handles cleanly on Page/App/Service destroy.
 * When keepActiveHardware is true (Single Execution AppService exit), active hardware Buzzer/Vibrator
 * waveforms are allowed to finish ringing out naturally instead of being clipped by onDestroy().
 */
export function releaseAllAudioHandles(options = {}) {
  const keepHw = Boolean(options && options.keepActiveHardware)
  clearPendingAudio(keepHw, keepHw)
  if (singletonPlayer) {
    try {
      if (typeof singletonPlayer.release === 'function') {
        singletonPlayer.release()
      }
    } catch (e) {}
  }
  activeBuzzer = null
  activeSysSounds = null
  activeVibrator = null
  singletonPlayer = null
  savedSystemVolume = null
  playerIsPlaying = false
}

function resolveBuzzerType(types, preferredKeys) {
  for (let i = 0; i < preferredKeys.length; i++) {
    const key = preferredKeys[i]
    if (types && types[key] !== undefined) {
      return types[key]
    }
  }
  return 0
}

export function getBuzzerRepeatCount(repeatLevel) {
  const lvl = Number(repeatLevel)
  if (Number.isFinite(lvl) && lvl >= 0 && lvl < BUZZER_REPEAT_COUNTS.length) {
    return BUZZER_REPEAT_COUNTS[Math.floor(lvl)]
  }
  return 0
}

function busyWaitMs(ms) {
  const target = Date.now() + ms
  while (Date.now() < target) {
    // Short synchronous wait for Single Execution AppService (immune to screen-off setTimeout freeze)
  }
}

/**
 * Play hardware-native Buzzer firmware waveform.
 * - gapMs === 0 (Auto) or single beep: ONE atomic firmware call buzzer.start(sourceType, repeatCount).
 * - gapMs > 0 (50..750 ms) with multiple repeats:
 *   - In background Single Execution AppService, when total span <= 525 ms (within Zepp OS 600 ms cap),
 *     performs an exact synchronous wait inside onInit() so screen-off setTimeout freeze / immediate
 *     Single Execution teardown can never cancel the repeat beeps.
 *   - In foreground UI (or spans > 525 ms), uses tracked scheduleTimer().
 */
function playBuzzerVariant(variantId, repeatLevel, gapMs = 0, isBackground = false) {
  try {
    if (!hasHardwareBuzzer()) {
      lastUiDiag = 'NO_HW_BUZZER'
      return { ok: false, syncDone: true }
    }
    if (!activeBuzzer) {
      activeBuzzer = new Buzzer()
    }
    const buzzer = activeBuzzer
    const types = typeof buzzer.getSourceType === 'function' ? buzzer.getSourceType() : {}
    const sysEnabled = typeof buzzer.isEnabled === 'function' ? (buzzer.isEnabled() ? 1 : 0) : '?'
    const sysStr = typeof buzzer.getStrength === 'function' ? buzzer.getStrength() : '?'
    const v = variantId || 'hw_operate'
    const repeatCount = getBuzzerRepeatCount(repeatLevel)
    const rawGap = Number(gapMs)
    const gap = Number.isFinite(rawGap) ? Math.max(0, Math.min(BUZZER_GAP_MAX_MS, Math.round(rawGap))) : 0

    const sourceKeyMap = {
      hw_operate: ['OPERATE', 'REMIND_1', 'ALARM'],
      hw_remind1: ['REMIND_1', 'OPERATE', 'ALARM'],
      hw_remind2: ['REMIND_2', 'REMIND_1', 'ALARM'],
      hw_alarm: ['ALARM', 'REMIND_1', 'OPERATE'],
      hw_success: ['SUCCESS', 'REMIND_1', 'ALARM'],
      hw_failure: ['FAILURE', 'REMIND_2', 'ALARM']
    }

    const preferredKeys = sourceKeyMap[v] || sourceKeyMap.hw_operate
    const sourceType = resolveBuzzerType(types, preferredKeys)
    let syncDone = true

    if (repeatCount > 0 && gap > 0) {
      const totalSpanMs = repeatCount * gap
      if (isBackground && totalSpanMs <= 525) {
        // Exact synchronous spacing inside Single Execution onInit (< 600ms system cap)
        buzzer.start(sourceType, 0)
        for (let i = 1; i <= repeatCount; i++) {
          busyWaitMs(gap)
          try {
            buzzer.stop()
          } catch (e) {}
          buzzer.start(sourceType, 0)
        }
        syncDone = true
      } else {
        syncDone = false
        buzzer.start(sourceType, 0)
        for (let i = 1; i <= repeatCount; i++) {
          scheduleTimer(() => {
            try {
              if (!activeBuzzer) return
              try {
                activeBuzzer.stop()
              } catch (e) {}
              activeBuzzer.start(sourceType, 0)
            } catch (e) {
              logger.error('playBuzzerVariant repeat failed:', e)
            }
          }, i * gap)
        }
      }
    } else {
      buzzer.start(sourceType, repeatCount)
      syncDone = true
    }

    if (!isBackground) {
      const gapTag = gap > 0 ? `${gap}ms` : 'auto'
      lastUiDiag = `UI:ok en=${sysEnabled} str=${sysStr} t=${sourceType} r=${repeatCount} g=${gapTag}`
    }
    return { ok: true, syncDone }
  } catch (e) {
    logger.error('playBuzzerVariant failed:', e)
    lastUiDiag = `UI:ERR ${e && e.message ? e.message : e}`
    return { ok: false, syncDone: true }
  }
}

/**
 * Fallback 2 rapid beeps using Zepp OS built-in SystemSounds.
 */
function playSystemSoundsDoubleBeep(onDone) {
  try {
    if (!hasHardwareSpeaker() || typeof SystemSounds !== 'function') {
      if (typeof onDone === 'function') onDone()
      return false
    }
    if (!activeSysSounds) {
      activeSysSounds = new SystemSounds()
    }
    const sysSounds = activeSysSounds
    if (typeof sysSounds.getEnabled === 'function' && !sysSounds.getEnabled()) {
      if (typeof onDone === 'function') onDone()
      return false
    }

    const types = typeof sysSounds.getSourceType === 'function' ? sysSounds.getSourceType() : {}
    const soundType =
      types.REGULAR !== undefined
        ? types.REGULAR
        : types.MESSAGE !== undefined
          ? types.MESSAGE
          : types.ACHIEVE !== undefined
            ? types.ACHIEVE
            : 0

    sysSounds.start(soundType, 0)

    scheduleTimer(() => {
      try {
        sysSounds.stop()
      } catch (e) {}
      try {
        sysSounds.start(soundType, 0)
      } catch (e) {}

      scheduleTimer(() => {
        try {
          sysSounds.stop()
        } catch (e) {}
        if (typeof onDone === 'function') onDone()
      }, 160)
    }, 135)

    return true
  } catch (e) {
    logger.error('playSystemSoundsDoubleBeep failed:', e)
    if (typeof onDone === 'function') onDone()
    return false
  }
}

function getOrCreatePlayer() {
  if (singletonPlayer) {
    return singletonPlayer
  }
  if (typeof createMedia !== 'function' || !mediaId || mediaId.PLAYER === undefined) {
    return null
  }

  const player = createMedia(mediaId.PLAYER)
  if (!player) {
    return null
  }

  player.addEventListener(player.event.PREPARE, (result) => {
    clearWatchdog()
    if (result) {
      try {
        if (typeof player.getVolume === 'function' && savedSystemVolume === null) {
          const prevVol = player.getVolume()
          if (typeof prevVol === 'number' && Number.isFinite(prevVol) && prevVol >= 0 && prevVol <= 100) {
            savedSystemVolume = prevVol
          }
        }
        if (typeof player.setVolume === 'function') {
          player.setVolume(pendingVolumeToApply)
        }
      } catch (e) {}

      try {
        playerIsPlaying = true
        player.start()
      } catch (e) {
        playerIsPlaying = false
        restoreSystemVolume()
        playSystemSoundsDoubleBeep(notifySpeakerDone)
      }
    } else {
      playerIsPlaying = false
      restoreSystemVolume()
      playSystemSoundsDoubleBeep(notifySpeakerDone)
    }
  })

  player.addEventListener(player.event.COMPLETE, () => {
    clearWatchdog()
    playerIsPlaying = false
    try {
      player.stop()
      lastPlayerStopTs = Date.now()
    } catch (e) {}
    scheduleTimer(() => {
      if (!playerIsPlaying) {
        restoreSystemVolume()
      }
      notifySpeakerDone()
    }, 60)
  })

  player.addEventListener(player.event.ERROR, () => {
    clearWatchdog()
    playerIsPlaying = false
    try {
      player.stop()
      lastPlayerStopTs = Date.now()
    } catch (e) {}
    restoreSystemVolume()
    playSystemSoundsDoubleBeep(notifySpeakerDone)
  })

  singletonPlayer = player
  return singletonPlayer
}

/**
 * Play speaker chime according to chosen variant (18 mastered MP3s) and volume (1..100).
 */
function playSpeakerVariant(variantId, volumePercent, onDone) {
  if (!hasHardwareSpeaker()) {
    if (typeof onDone === 'function') onDone()
    return false
  }

  const v = variantId || 'retro_1989'
  const rawVol = Number(volumePercent)
  const vol = Number.isFinite(rawVol) ? Math.max(1, Math.min(100, Math.round(rawVol))) : 10
  pendingVolumeToApply = vol

  const mp3File = SPEAKER_FILE_MAP[v] || SPEAKER_FILE_MAP.retro_1989

  try {
    const player = getOrCreatePlayer()
    if (!player) {
      return playSystemSoundsDoubleBeep(onDone)
    }

    const myToken = ++playerPlayToken
    clearWatchdog()
    pendingSpeakerDone = typeof onDone === 'function' ? onDone : null

    let needsResetDelay = Date.now() - lastPlayerStopTs < 50
    try {
      const status = typeof player.getStatus === 'function' ? player.getStatus() : null
      const idleState = player.state ? player.state.IDLE : 0
      if (playerIsPlaying || (status !== null && status !== idleState)) {
        player.stop()
        lastPlayerStopTs = Date.now()
        playerIsPlaying = false
        needsResetDelay = true
      }
    } catch (e) {
      try {
        player.stop()
        lastPlayerStopTs = Date.now()
      } catch (err) {}
      playerIsPlaying = false
      needsResetDelay = true
    }

    const startPrepare = () => {
      if (myToken !== playerPlayToken) {
        return
      }
      try {
        player.setSource(player.source.FILE, {
          file: mp3File
        })

        playerWatchdogId = setTimeout(() => {
          playerWatchdogId = null
          if (myToken === playerPlayToken && !playerIsPlaying) {
            try {
              player.stop()
              lastPlayerStopTs = Date.now()
            } catch (e) {}
            restoreSystemVolume()
            playSystemSoundsDoubleBeep(notifySpeakerDone)
          }
        }, 1800)

        player.prepare()
      } catch (e) {
        clearWatchdog()
        restoreSystemVolume()
        playSystemSoundsDoubleBeep(notifySpeakerDone)
      }
    }

    if (needsResetDelay) {
      scheduleTimer(startPrepare, 40)
    } else {
      startPrepare()
    }

    return true
  } catch (e) {
    logger.warn('Media player error, using SystemSounds fallback:', e)
    return playSystemSoundsDoubleBeep(onDone)
  }
}

function runTimedFallbackVibration(vibrator, sceneMode, count, spacingMs) {
  for (let i = 0; i < count; i++) {
    const startAt = i * spacingMs
    const fire = () => {
      try {
        vibrator.stop()
        vibrator.start({ mode: sceneMode })
      } catch (e) {}
    }
    if (startAt === 0) {
      fire()
    } else {
      scheduleTimer(fire, startAt)
    }
  }
}

/**
 * Play hardware vibration according to selected mode and strength (0=Light, 1=Medium, 2=Strong).
 */
function playVibrateMode(modeId, strengthLevel) {
  if (!hasHardwareVibrator()) {
    return false
  }

  const m = modeId || 'double_short'
  const rawStr = Number(strengthLevel)
  const str = Number.isFinite(rawStr) ? Math.max(0, Math.min(2, Math.floor(rawStr))) : 1

  try {
    if (!activeVibrator) {
      activeVibrator = new Vibrator()
    }
    const vibrator = activeVibrator
    vibrator.stop()

    if (m === 'notify_hw') {
      vibrator.start({ mode: VIBRATOR_SCENE_NOTIFICATION })
      return true
    }

    const t = typeof vibrator.getType === 'function' ? vibrator.getType() : null
    if (t && t.PAUSE !== undefined && t.STRONG_SHORT !== undefined) {
      const shortAction =
        str === 0
          ? { type: t.GENTLE_SHORT !== undefined ? t.GENTLE_SHORT : t.STRONG_SHORT }
          : str === 1
            ? { type: t.STRONG_SHORT }
            : t.URGENT !== undefined
              ? { type: t.URGENT }
              : { type: t.CONTINUOUS !== undefined ? t.CONTINUOUS : t.STRONG_SHORT, duration: 95 }

      const crownAction =
        str === 0
          ? { type: t.STANDARD_CROWN !== undefined ? t.STANDARD_CROWN : shortAction.type }
          : str === 1
            ? { type: t.STRONG_CROWN !== undefined ? t.STRONG_CROWN : shortAction.type }
            : { type: t.DIPULSE_CROWN !== undefined ? t.DIPULSE_CROWN : shortAction.type }

      const longDur = str === 0 ? 120 : str === 1 ? 220 : 340
      const longAction =
        t.CONTINUOUS !== undefined
          ? { type: t.CONTINUOUS, duration: longDur }
          : shortAction

      switch (m) {
        case 'double_short':
          vibrator.start([shortAction, { type: t.PAUSE, duration: 130 }, shortAction])
          return true
        case 'double_crown':
          vibrator.start([crownAction, { type: t.PAUSE, duration: 120 }, crownAction])
          return true
        case 'triple_short':
          vibrator.start([
            shortAction,
            { type: t.PAUSE, duration: 105 },
            shortAction,
            { type: t.PAUSE, duration: 105 },
            shortAction
          ])
          return true
        case 'short_long':
          vibrator.start([shortAction, { type: t.PAUSE, duration: 120 }, longAction])
          return true
        case 'long_short':
          vibrator.start([longAction, { type: t.PAUSE, duration: 120 }, shortAction])
          return true
        case 'single_pulse':
          vibrator.start([str === 2 ? longAction : shortAction])
          return true
        default:
          vibrator.start([shortAction, { type: t.PAUSE, duration: 130 }, shortAction])
          return true
      }
    }

    const sceneForStrength =
      str === 0
        ? VIBRATOR_SCENE_SHORT_LIGHT
        : str === 1
          ? VIBRATOR_SCENE_SHORT_MIDDLE
          : VIBRATOR_SCENE_SHORT_STRONG

    switch (m) {
      case 'double_short':
      case 'double_crown':
        runTimedFallbackVibration(vibrator, sceneForStrength, 2, 220)
        break
      case 'triple_short':
        runTimedFallbackVibration(vibrator, sceneForStrength, 3, 200)
        break
      case 'short_long':
        vibrator.start({ mode: sceneForStrength })
        scheduleTimer(() => {
          try {
            vibrator.stop()
            vibrator.start({ mode: VIBRATOR_SCENE_DURATION })
          } catch (e) {}
        }, 220)
        break
      case 'long_short':
        vibrator.start({ mode: VIBRATOR_SCENE_DURATION })
        scheduleTimer(() => {
          try {
            vibrator.stop()
            vibrator.start({ mode: sceneForStrength })
          } catch (e) {}
        }, 680)
        break
      case 'single_pulse':
        vibrator.start({ mode: str === 2 ? VIBRATOR_SCENE_DURATION : sceneForStrength })
        break
      default:
        vibrator.start({ mode: VIBRATOR_SCENE_NOTIFICATION })
        break
    }

    return true
  } catch (e) {
    logger.error('playVibrateMode failed:', e)
    return false
  }
}

export function previewBuzzerVariant(variantId, repeatLevel, gapMs = 0) {
  clearPendingAudio(false)
  playBuzzerVariant(variantId, repeatLevel, gapMs, false)
}

export function previewSpeakerVariant(variantId, volumePercent) {
  clearPendingAudio(false)
  playSpeakerVariant(variantId, volumePercent)
}

export function previewVibrateMode(modeId, strengthLevel) {
  clearPendingAudio(false)
  playVibrateMode(modeId, strengthLevel)
}

/**
 * Execute enabled & hardware-supported channels (respecting optional DND overrides).
 * Calls onDone() once playback completes (used by Single Execution AppService to exit cleanly).
 */
export function playHourlyChime(cfg, options = {}) {
  const isBackground = Boolean(options.isBackground)
  const allowSound = options.allowSound !== undefined ? Boolean(options.allowSound) : true
  const allowVibrate = options.allowVibrate !== undefined ? Boolean(options.allowVibrate) : true
  const onDone = typeof options.onDone === 'function' ? options.onDone : null

  clearPendingAudio(isBackground)

  const caps = getHardwareCapabilities()
  const runVibrate = Boolean(cfg.vibrateEnabled && allowVibrate && caps.hasVibrator)
  const runBuzzer = Boolean(cfg.buzzerEnabled && allowSound && caps.hasBuzzer)
  const runSpeaker = Boolean(cfg.speakerEnabled && allowSound && caps.hasSpeaker)

  if (!runVibrate && !runBuzzer && !runSpeaker) {
    if (onDone) onDone()
    return false
  }

  let finished = false
  const finishOnce = () => {
    if (finished) return
    finished = true
    if (onDone) onDone()
  }

  if (runVibrate) {
    playVibrateMode(cfg.vibrateMode, cfg.vibrateStrength)
  }

  let buzzerResult = { ok: false, syncDone: true }
  if (runBuzzer) {
    buzzerResult = playBuzzerVariant(cfg.buzzerVariant, cfg.buzzerRepeats, cfg.buzzerGapMs, isBackground)
  }

  let minSettleMs = 0
  if (runBuzzer && !buzzerResult.syncDone) {
    const repeatCount = getBuzzerRepeatCount(cfg.buzzerRepeats)
    const rawGap = Number(cfg.buzzerGapMs)
    const gap = Number.isFinite(rawGap) ? Math.max(0, Math.min(BUZZER_GAP_MAX_MS, Math.round(rawGap))) : 0
    if (repeatCount > 0 && gap > 0) {
      minSettleMs = Math.max(minSettleMs, Math.min(3600, repeatCount * gap + 650))
    }
  }
  if (runVibrate) {
    minSettleMs = Math.max(minSettleMs, 950)
  }

  if (runSpeaker) {
    const startTs = Date.now()
    if (onDone) {
      scheduleTimer(finishOnce, Math.max(3800, minSettleMs + 500))
    }
    playSpeakerVariant(cfg.speakerVariant, cfg.speakerVolume, () => {
      if (!onDone) return
      const elapsed = Date.now() - startTs
      const remaining = Math.max(0, minSettleMs - elapsed)
      if (remaining > 0) {
        scheduleTimer(finishOnce, remaining)
      } else {
        finishOnce()
      }
    })
  } else if (onDone) {
    if (minSettleMs <= 0) {
      finishOnce()
    } else {
      scheduleTimer(finishOnce, minSettleMs)
    }
  }

  return true
}
