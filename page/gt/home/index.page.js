import * as hmUI from '@zos/ui'
import { getDeviceInfo, SCREEN_SHAPE_SQUARE } from '@zos/device'
import { px, log as Logger } from '@zos/utils'
import { t } from '../../../utils/i18n'
import {
  APP_VERSION,
  BUZZER_GAP_MAX_MS,
  BUZZER_GAP_MIN_MS,
  BUZZER_GAP_STEP_MS
} from '../../../utils/constants'
import {
  BUZZER_VARIANTS,
  BUZZER_REPEAT_LEVELS,
  SPEAKER_VARIANTS,
  VIBRATE_MODES,
  VIBRATE_STRENGTHS
} from '../../../utils/catalog'
import {
  flushPendingConfigSave,
  hasAnyActiveChannel,
  loadConfig,
  loadRuntimeState,
  updateConfig
} from '../../../utils/storage'
import {
  getHardwareCapabilities,
  getLastUiDiag,
  isSystemBuzzerEnabled,
  playHourlyChime,
  previewBuzzerVariant,
  previewSpeakerVariant,
  previewVibrateMode,
  releaseAllAudioHandles
} from '../../../utils/audio'
import {
  formatHour,
  getBackgroundDiagnostics,
  getNextChimeLabel,
  getSystemSilentMode,
  is12HourFormat,
  scheduleTestAlarm15s,
  stopLegacyContinuousService,
  syncBackgroundSchedule
} from '../../../utils/schedule'

const logger = Logger.getLogger('hourly_chime_page')

const COLORS = {
  BG_DARK: 0x000000,
  BTN_NORMAL: 0x262c36,
  BTN_PRESS: 0x3b4454,
  BTN_DISABLED: 0x15181e,
  TEXT_DISABLED: 0x4b5360,
  BTN_VARIANT: 0x1f2630,
  BTN_VARIANT_PRESS: 0x323d4d,
  ORANGE: 0xff6b00,
  ORANGE_PRESS: 0xff8c33,
  GREEN: 0x1db954,
  GREEN_PRESS: 0x27d665,
  BLUE: 0x0066cc,
  BLUE_PRESS: 0x1e88e5,
  RED: 0xd32f2f,
  RED_PRESS: 0xf44336,
  WHITE: 0xffffff,
  GRAY: 0x9aa4b2,
  DIM_GRAY: 0x5c6675
}

const APP_VERSION_LABEL = `v${APP_VERSION}`
const DEBUG_UNLOCK_TAPS = 10

function fs(designPx, minPx = 14) {
  return Math.max(minPx, Math.round(px(designPx)))
}

function findVariantIndex(list, id) {
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) {
      return i
    }
  }
  return 0
}

function getRepeatLabel(level) {
  for (let i = 0; i < BUZZER_REPEAT_LEVELS.length; i++) {
    if (BUZZER_REPEAT_LEVELS[i].level === Number(level)) {
      return BUZZER_REPEAT_LEVELS[i].label
    }
  }
  return BUZZER_REPEAT_LEVELS[0].label
}

function getVibrateStrengthLabel(level) {
  for (let i = 0; i < VIBRATE_STRENGTHS.length; i++) {
    if (VIBRATE_STRENGTHS[i].level === Number(level)) {
      return t(VIBRATE_STRENGTHS[i].i18nKey, VIBRATE_STRENGTHS[i].fallback)
    }
  }
  return t(VIBRATE_STRENGTHS[1].i18nKey, VIBRATE_STRENGTHS[1].fallback)
}

function readDeviceMeta() {
  let deviceName = 'Zepp OS'
  let isSquare = false
  try {
    const info = getDeviceInfo()
    if (info) {
      if (info.deviceName !== undefined && info.deviceName !== null) {
        const name = String(info.deviceName).trim()
        if (name.length > 0) {
          deviceName = name
        }
      }
      isSquare = info.screenShape === SCREEN_SHAPE_SQUARE
    }
  } catch (e) {
    logger.warn('getDeviceInfo failed:', e)
  }
  return { deviceName, isSquare }
}

/**
 * Dirty-checked Zepp OS BUTTON wrapper: avoids redundant IPC redraws when properties are unchanged.
 */
function makeButton(initialProps) {
  const props = { ...initialProps }
  const widget = hmUI.createWidget(hmUI.widget.BUTTON, props)
  return {
    widget,
    update(changes) {
      let dirty = false
      const keys = Object.keys(changes)
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]
        if (props[k] !== changes[k]) {
          props[k] = changes[k]
          dirty = true
        }
      }
      if (dirty) {
        widget.setProperty(hmUI.prop.MORE, { ...props })
      }
    }
  }
}

/**
 * Dirty-checked Zepp OS TEXT wrapper: passes full props on change + explicit prop.TEXT.
 */
function makeText(initialProps) {
  const props = { ...initialProps }
  const widget = hmUI.createWidget(hmUI.widget.TEXT, props)
  return {
    widget,
    update(changes) {
      let dirty = false
      const keys = Object.keys(changes)
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]
        if (props[k] !== changes[k]) {
          props[k] = changes[k]
          dirty = true
        }
      }
      if (dirty) {
        widget.setProperty(hmUI.prop.MORE, { ...props })
        if (changes.text !== undefined) {
          try {
            widget.setProperty(hmUI.prop.TEXT, changes.text)
          } catch (e) {}
        }
      }
    },
    setVisible(visible) {
      try {
        widget.setProperty(hmUI.prop.VISIBLE, Boolean(visible))
      } catch (e) {}
    }
  }
}

Page({
  state: {
    config: null,
    widgets: {},
    caps: {
      hasBuzzer: false,
      hasSpeaker: false,
      hasVibrator: false
    },
    sysBuzzerEnabled: true,
    deviceName: 'Zepp OS',
    isSquare: false,
    footerTapCount: 0,
    debugUnlocked: false,
    debugBuilt: false,
    debugBaseY: 0,
    alarmError: false,
    bgTestScheduled: false,
    destroyed: false
  },

  onInit() {
    this.state.destroyed = false
    this.state.widgets = {}
    this.state.footerTapCount = 0
    this.state.debugUnlocked = false
    this.state.debugBuilt = false
    this.state.alarmError = false
    this.state.bgTestScheduled = false

    // Cleanly stop any leftover continuous AppService from older versions (v2.2.0)
    stopLegacyContinuousService()

    const meta = readDeviceMeta()
    this.state.deviceName = meta.deviceName
    this.state.isSquare = meta.isSquare

    const caps = getHardwareCapabilities()
    this.state.caps = caps
    this.state.sysBuzzerEnabled = caps.hasBuzzer ? isSystemBuzzerEnabled() : false

    let cfg = loadConfig()
    const patch = {}
    let hadUnsupportedEnabled = false

    if (!caps.hasBuzzer && cfg.buzzerEnabled) {
      patch.buzzerEnabled = false
      hadUnsupportedEnabled = true
    }
    if (!caps.hasSpeaker && cfg.speakerEnabled) {
      patch.speakerEnabled = false
      hadUnsupportedEnabled = true
    }
    if (!caps.hasVibrator && cfg.vibrateEnabled) {
      patch.vibrateEnabled = false
      hadUnsupportedEnabled = true
    }

    if (hadUnsupportedEnabled) {
      const nextCfg = { ...cfg, ...patch }
      if (!hasAnyActiveChannel(nextCfg, caps)) {
        if (caps.hasBuzzer) {
          patch.buzzerEnabled = true
        } else if (caps.hasSpeaker) {
          patch.speakerEnabled = true
        } else if (caps.hasVibrator) {
          patch.vibrateEnabled = true
        }
      }
      cfg = updateConfig(patch, cfg, true)
    }

    this.state.config = cfg
  },

  build() {
    const cfg = this.state.config || loadConfig()
    const w = this.state.widgets
    const caps = this.state.caps
    const { hasBuzzer, hasSpeaker, hasVibrator } = caps
    const hasAnySound = hasBuzzer || hasSpeaker
    const isSquare = this.state.isSquare
    const deviceName = this.state.deviceName

    if (isSquare && typeof hmUI.setStatusBarVisible === 'function') {
      try {
        hmUI.setStatusBarVisible(false)
      } catch (e) {}
    }

    let curY = isSquare ? 18 : 54

    // 1. Header Title (padded safely inside round bezel)
    hmUI.createWidget(hmUI.widget.TEXT, {
      x: px(isSquare ? 20 : 64),
      y: px(curY),
      w: px(isSquare ? 440 : 352),
      h: px(36),
      color: COLORS.WHITE,
      text_size: fs(23, 17),
      align_h: hmUI.align.CENTER_H,
      align_v: hmUI.align.CENTER_V,
      text_style: hmUI.text_style.ELLIPSIS,
      text: t('title', 'RETRO HOURLY CHIME')
    })
    curY += 38

    // Live Next Chime Status
    w.statusText = makeText({
      x: px(isSquare ? 20 : 46),
      y: px(curY),
      w: px(isSquare ? 440 : 388),
      h: px(30),
      color: COLORS.ORANGE,
      text_size: fs(19, 15),
      align_h: hmUI.align.CENTER_H,
      align_v: hmUI.align.CENTER_V,
      text_style: hmUI.text_style.ELLIPSIS,
      text: ''
    })
    curY += 40

    // 2. Master Enable Toggle Button
    w.masterBtn = makeButton({
      x: px(60),
      y: px(curY),
      w: px(360),
      h: px(68),
      radius: px(34),
      text_size: fs(23, 17),
      color: COLORS.WHITE,
      normal_color: COLORS.GREEN,
      press_color: COLORS.GREEN_PRESS,
      text: t('masterOn', '●  ACTIVE (ON)'),
      click_func: () => {
        this.applyConfigChange({ enabled: !this.state.config.enabled }, true, true)
      }
    })
    curY += 86

    // 3. Independent Channel Toggles: BUZZER | SPEAKER | VIBR.
    hmUI.createWidget(hmUI.widget.TEXT, {
      x: px(34),
      y: px(curY),
      w: px(412),
      h: px(28),
      color: COLORS.GRAY,
      text_size: fs(19, 14),
      align_h: hmUI.align.CENTER_H,
      align_v: hmUI.align.CENTER_V,
      text: t('channelsHeader', 'ACTIVE CHANNELS')
    })
    curY += 34

    const lblBuz = t('chBuzzer', 'BUZZER')
    const lblSpk = t('chSpeaker', 'SPEAKER')
    const lblVib = t('chVibrate', 'VIBR.')

    if (hasBuzzer) {
      w.btnBuzzerToggle = makeButton({
        x: px(34),
        y: px(curY),
        w: px(132),
        h: px(74),
        radius: px(18),
        text_size: fs(18, 14),
        color: COLORS.WHITE,
        normal_color: COLORS.BTN_NORMAL,
        press_color: COLORS.BTN_PRESS,
        text: `● ${lblBuz}`,
        click_func: () => {
          this.state.sysBuzzerEnabled = isSystemBuzzerEnabled()
          this.applyConfigChange({ buzzerEnabled: !this.state.config.buzzerEnabled }, true, true)
        }
      })
    } else {
      w.btnBuzzerToggle = makeButton({
        x: px(34),
        y: px(curY),
        w: px(132),
        h: px(74),
        radius: px(18),
        text_size: fs(18, 14),
        color: COLORS.TEXT_DISABLED,
        normal_color: COLORS.BTN_DISABLED,
        press_color: COLORS.BTN_DISABLED,
        text: `× ${lblBuz}`,
        click_func: () => {}
      })
    }

    if (hasSpeaker) {
      w.btnSpeakerToggle = makeButton({
        x: px(174),
        y: px(curY),
        w: px(132),
        h: px(74),
        radius: px(18),
        text_size: fs(18, 14),
        color: COLORS.WHITE,
        normal_color: COLORS.BTN_NORMAL,
        press_color: COLORS.BTN_PRESS,
        text: `○ ${lblSpk}`,
        click_func: () => {
          this.applyConfigChange({ speakerEnabled: !this.state.config.speakerEnabled }, true, true)
        }
      })
    } else {
      w.btnSpeakerToggle = makeButton({
        x: px(174),
        y: px(curY),
        w: px(132),
        h: px(74),
        radius: px(18),
        text_size: fs(18, 14),
        color: COLORS.TEXT_DISABLED,
        normal_color: COLORS.BTN_DISABLED,
        press_color: COLORS.BTN_DISABLED,
        text: `× ${lblSpk}`,
        click_func: () => {}
      })
    }

    if (hasVibrator) {
      w.btnVibrateToggle = makeButton({
        x: px(314),
        y: px(curY),
        w: px(132),
        h: px(74),
        radius: px(18),
        text_size: fs(18, 14),
        color: COLORS.WHITE,
        normal_color: COLORS.BTN_NORMAL,
        press_color: COLORS.BTN_PRESS,
        text: `○ ${lblVib}`,
        click_func: () => {
          this.applyConfigChange({ vibrateEnabled: !this.state.config.vibrateEnabled }, true, true)
        }
      })
    } else {
      w.btnVibrateToggle = makeButton({
        x: px(314),
        y: px(curY),
        w: px(132),
        h: px(74),
        radius: px(18),
        text_size: fs(18, 14),
        color: COLORS.TEXT_DISABLED,
        normal_color: COLORS.BTN_DISABLED,
        press_color: COLORS.BTN_DISABLED,
        text: `× ${lblVib}`,
        click_func: () => {}
      })
    }
    curY += 92

    // 4. Hardware-Native Buzzer Section (rendered ONLY if device has hardware Buzzer)
    if (hasBuzzer) {
      hmUI.createWidget(hmUI.widget.TEXT, {
        x: px(34),
        y: px(curY),
        w: px(412),
        h: px(28),
        color: COLORS.GRAY,
        text_size: fs(19, 14),
        align_h: hmUI.align.CENTER_H,
        align_v: hmUI.align.CENTER_V,
        text: t('secBuzzer', 'BUZZER: TONE & REPEATS')
      })
      curY += 32

      if (!this.state.sysBuzzerEnabled) {
        w.textSysBuzzerWarn = makeText({
          x: px(34),
          y: px(curY),
          w: px(412),
          h: px(26),
          color: COLORS.RED_PRESS,
          text_size: fs(16, 13),
          align_h: hmUI.align.CENTER_H,
          align_v: hmUI.align.CENTER_V,
          text_style: hmUI.text_style.ELLIPSIS,
          text: t('warnSysBuzzer', 'Enable Buzzer in Watch Settings')
        })
        curY += 30
      }

      hmUI.createWidget(hmUI.widget.BUTTON, {
        x: px(34),
        y: px(curY),
        w: px(68),
        h: px(62),
        radius: px(16),
        text_size: fs(30, 22),
        color: COLORS.WHITE,
        normal_color: COLORS.BTN_NORMAL,
        press_color: COLORS.BTN_PRESS,
        text: '<',
        click_func: () => {
          this.cycleBuzzerVariant(-1)
        }
      })

      w.btnBuzzerName = makeButton({
        x: px(110),
        y: px(curY),
        w: px(260),
        h: px(62),
        radius: px(16),
        text_size: fs(20, 15),
        color: COLORS.ORANGE,
        normal_color: COLORS.BTN_VARIANT,
        press_color: COLORS.BTN_VARIANT_PRESS,
        text: t(BUZZER_VARIANTS[0].i18nKey, BUZZER_VARIANTS[0].fallback),
        click_func: () => {
          previewBuzzerVariant(
            this.state.config.buzzerVariant,
            this.state.config.buzzerRepeats,
            this.state.config.buzzerGapMs
          )
          if (this.state.debugUnlocked) this.refreshDebugLog()
        }
      })

      hmUI.createWidget(hmUI.widget.BUTTON, {
        x: px(378),
        y: px(curY),
        w: px(68),
        h: px(62),
        radius: px(16),
        text_size: fs(30, 22),
        color: COLORS.WHITE,
        normal_color: COLORS.BTN_NORMAL,
        press_color: COLORS.BTN_PRESS,
        text: '>',
        click_func: () => {
          this.cycleBuzzerVariant(1)
        }
      })
      curY += 72

      hmUI.createWidget(hmUI.widget.BUTTON, {
        x: px(34),
        y: px(curY),
        w: px(68),
        h: px(56),
        radius: px(16),
        text_size: fs(30, 22),
        color: COLORS.WHITE,
        normal_color: COLORS.BTN_NORMAL,
        press_color: COLORS.BTN_PRESS,
        text: '-',
        click_func: () => {
          this.stepBuzzerRepeats(-1)
        }
      })

      w.btnBuzzerRepeats = makeButton({
        x: px(110),
        y: px(curY),
        w: px(260),
        h: px(56),
        radius: px(16),
        text_size: fs(20, 15),
        color: COLORS.WHITE,
        normal_color: COLORS.BTN_VARIANT,
        press_color: COLORS.BTN_VARIANT_PRESS,
        text: `${t('repeatsPrefix', 'Repeats:')} 2x`,
        click_func: () => {
          previewBuzzerVariant(
            this.state.config.buzzerVariant,
            this.state.config.buzzerRepeats,
            this.state.config.buzzerGapMs
          )
          if (this.state.debugUnlocked) this.refreshDebugLog()
        }
      })

      hmUI.createWidget(hmUI.widget.BUTTON, {
        x: px(378),
        y: px(curY),
        w: px(68),
        h: px(56),
        radius: px(16),
        text_size: fs(30, 22),
        color: COLORS.WHITE,
        normal_color: COLORS.BTN_NORMAL,
        press_color: COLORS.BTN_PRESS,
        text: '+',
        click_func: () => {
          this.stepBuzzerRepeats(1)
        }
      })
      curY += 66

      // Buzzer Repeat Gap Row: [ - ] Gap: Auto / 50..750ms [ + ]
      hmUI.createWidget(hmUI.widget.BUTTON, {
        x: px(34),
        y: px(curY),
        w: px(68),
        h: px(56),
        radius: px(16),
        text_size: fs(30, 22),
        color: COLORS.WHITE,
        normal_color: COLORS.BTN_NORMAL,
        press_color: COLORS.BTN_PRESS,
        text: '-',
        click_func: () => {
          this.stepBuzzerGap(-1)
        }
      })

      w.btnBuzzerGap = makeButton({
        x: px(110),
        y: px(curY),
        w: px(260),
        h: px(56),
        radius: px(16),
        text_size: fs(19, 14),
        color: COLORS.WHITE,
        normal_color: COLORS.BTN_VARIANT,
        press_color: COLORS.BTN_VARIANT_PRESS,
        text: `${t('gapPrefix', 'Gap:')} ${t('gapAuto', 'Auto')}`,
        click_func: () => {
          previewBuzzerVariant(
            this.state.config.buzzerVariant,
            this.state.config.buzzerRepeats,
            this.state.config.buzzerGapMs
          )
          if (this.state.debugUnlocked) this.refreshDebugLog()
        }
      })

      hmUI.createWidget(hmUI.widget.BUTTON, {
        x: px(378),
        y: px(curY),
        w: px(68),
        h: px(56),
        radius: px(16),
        text_size: fs(30, 22),
        color: COLORS.WHITE,
        normal_color: COLORS.BTN_NORMAL,
        press_color: COLORS.BTN_PRESS,
        text: '+',
        click_func: () => {
          this.stepBuzzerGap(1)
        }
      })
      curY += 74
    }

    // 5. Speaker Variant + Volume Section (rendered ONLY if device has hardware Speaker)
    if (hasSpeaker) {
      hmUI.createWidget(hmUI.widget.TEXT, {
        x: px(34),
        y: px(curY),
        w: px(412),
        h: px(28),
        color: COLORS.GRAY,
        text_size: fs(19, 14),
        align_h: hmUI.align.CENTER_H,
        align_v: hmUI.align.CENTER_V,
        text: t('secSpeaker', 'SPEAKER: TONE & VOLUME')
      })
      curY += 32

      hmUI.createWidget(hmUI.widget.BUTTON, {
        x: px(34),
        y: px(curY),
        w: px(68),
        h: px(62),
        radius: px(16),
        text_size: fs(30, 22),
        color: COLORS.WHITE,
        normal_color: COLORS.BTN_NORMAL,
        press_color: COLORS.BTN_PRESS,
        text: '<',
        click_func: () => {
          this.cycleSpeakerVariant(-1)
        }
      })

      w.btnSpeakerName = makeButton({
        x: px(110),
        y: px(curY),
        w: px(260),
        h: px(62),
        radius: px(16),
        text_size: fs(19, 14),
        color: COLORS.ORANGE,
        normal_color: COLORS.BTN_VARIANT,
        press_color: COLORS.BTN_VARIANT_PRESS,
        text: t(SPEAKER_VARIANTS[0].i18nKey, SPEAKER_VARIANTS[0].fallback),
        click_func: () => {
          previewSpeakerVariant(this.state.config.speakerVariant, this.state.config.speakerVolume)
        }
      })

      hmUI.createWidget(hmUI.widget.BUTTON, {
        x: px(378),
        y: px(curY),
        w: px(68),
        h: px(62),
        radius: px(16),
        text_size: fs(30, 22),
        color: COLORS.WHITE,
        normal_color: COLORS.BTN_NORMAL,
        press_color: COLORS.BTN_PRESS,
        text: '>',
        click_func: () => {
          this.cycleSpeakerVariant(1)
        }
      })
      curY += 72

      hmUI.createWidget(hmUI.widget.BUTTON, {
        x: px(34),
        y: px(curY),
        w: px(68),
        h: px(56),
        radius: px(16),
        text_size: fs(30, 22),
        color: COLORS.WHITE,
        normal_color: COLORS.BTN_NORMAL,
        press_color: COLORS.BTN_PRESS,
        text: '-',
        click_func: () => {
          this.stepSpeakerVolume(-1)
        }
      })

      w.btnSpeakerVol = makeButton({
        x: px(110),
        y: px(curY),
        w: px(260),
        h: px(56),
        radius: px(16),
        text_size: fs(19, 14),
        color: COLORS.WHITE,
        normal_color: COLORS.BTN_VARIANT,
        press_color: COLORS.BTN_VARIANT_PRESS,
        text: `${t('volumePrefix', 'Volume:')} 10%`,
        click_func: () => {
          previewSpeakerVariant(this.state.config.speakerVariant, this.state.config.speakerVolume)
        }
      })

      hmUI.createWidget(hmUI.widget.BUTTON, {
        x: px(378),
        y: px(curY),
        w: px(68),
        h: px(56),
        radius: px(16),
        text_size: fs(30, 22),
        color: COLORS.WHITE,
        normal_color: COLORS.BTN_NORMAL,
        press_color: COLORS.BTN_PRESS,
        text: '+',
        click_func: () => {
          this.stepSpeakerVolume(1)
        }
      })
      curY += 74
    }

    // 6. Vibration Mode + Strength Section (rendered ONLY if device has hardware Vibrator)
    if (hasVibrator) {
      hmUI.createWidget(hmUI.widget.TEXT, {
        x: px(34),
        y: px(curY),
        w: px(412),
        h: px(28),
        color: COLORS.GRAY,
        text_size: fs(19, 14),
        align_h: hmUI.align.CENTER_H,
        align_v: hmUI.align.CENTER_V,
        text: t('secVibrate', 'VIBRATION: MODE & POWER')
      })
      curY += 32

      hmUI.createWidget(hmUI.widget.BUTTON, {
        x: px(34),
        y: px(curY),
        w: px(68),
        h: px(62),
        radius: px(16),
        text_size: fs(30, 22),
        color: COLORS.WHITE,
        normal_color: COLORS.BTN_NORMAL,
        press_color: COLORS.BTN_PRESS,
        text: '<',
        click_func: () => {
          this.cycleVibrateMode(-1)
        }
      })

      w.btnVibrateName = makeButton({
        x: px(110),
        y: px(curY),
        w: px(260),
        h: px(62),
        radius: px(16),
        text_size: fs(20, 15),
        color: COLORS.ORANGE,
        normal_color: COLORS.BTN_VARIANT,
        press_color: COLORS.BTN_VARIANT_PRESS,
        text: t(VIBRATE_MODES[0].i18nKey, VIBRATE_MODES[0].fallback),
        click_func: () => {
          previewVibrateMode(this.state.config.vibrateMode, this.state.config.vibrateStrength)
        }
      })

      hmUI.createWidget(hmUI.widget.BUTTON, {
        x: px(378),
        y: px(curY),
        w: px(68),
        h: px(62),
        radius: px(16),
        text_size: fs(30, 22),
        color: COLORS.WHITE,
        normal_color: COLORS.BTN_NORMAL,
        press_color: COLORS.BTN_PRESS,
        text: '>',
        click_func: () => {
          this.cycleVibrateMode(1)
        }
      })
      curY += 72

      hmUI.createWidget(hmUI.widget.BUTTON, {
        x: px(34),
        y: px(curY),
        w: px(68),
        h: px(56),
        radius: px(16),
        text_size: fs(30, 22),
        color: COLORS.WHITE,
        normal_color: COLORS.BTN_NORMAL,
        press_color: COLORS.BTN_PRESS,
        text: '-',
        click_func: () => {
          this.stepVibrateStrength(-1)
        }
      })

      w.btnVibrateStrength = makeButton({
        x: px(110),
        y: px(curY),
        w: px(260),
        h: px(56),
        radius: px(16),
        text_size: fs(19, 14),
        color: COLORS.WHITE,
        normal_color: COLORS.BTN_VARIANT,
        press_color: COLORS.BTN_VARIANT_PRESS,
        text: `${t('powerPrefix', 'Power:')} ${getVibrateStrengthLabel(cfg.vibrateStrength)}`,
        click_func: () => {
          previewVibrateMode(this.state.config.vibrateMode, this.state.config.vibrateStrength)
        }
      })

      hmUI.createWidget(hmUI.widget.BUTTON, {
        x: px(378),
        y: px(curY),
        w: px(68),
        h: px(56),
        radius: px(16),
        text_size: fs(30, 22),
        color: COLORS.WHITE,
        normal_color: COLORS.BTN_NORMAL,
        press_color: COLORS.BTN_PRESS,
        text: '+',
        click_func: () => {
          this.stepVibrateStrength(1)
        }
      })
      curY += 74
    }

    // 7. Active Hours Section
    hmUI.createWidget(hmUI.widget.TEXT, {
      x: px(34),
      y: px(curY),
      w: px(412),
      h: px(28),
      color: COLORS.GRAY,
      text_size: fs(19, 14),
      align_h: hmUI.align.CENTER_H,
      align_v: hmUI.align.CENTER_V,
      text: t('secHours', 'ACTIVE HOURS')
    })
    curY += 34

    w.btnAllDay = makeButton({
      x: px(60),
      y: px(curY),
      w: px(360),
      h: px(56),
      radius: px(28),
      text_size: fs(20, 15),
      color: COLORS.WHITE,
      normal_color: COLORS.BTN_NORMAL,
      press_color: COLORS.BTN_PRESS,
      text: t('modeRange', 'Mode: HOUR RANGE'),
      click_func: () => {
        this.applyConfigChange({ allDay: !this.state.config.allDay }, true, true)
      }
    })
    curY += 72

    const hourTextSize = is12HourFormat() ? fs(26, 19) : fs(32, 24)

    // Start Hour Row ("FROM") — roomy center column for both "08:00" and "12:00 AM"
    hmUI.createWidget(hmUI.widget.TEXT, {
      x: px(32),
      y: px(curY),
      w: px(92),
      h: px(60),
      color: COLORS.GRAY,
      text_size: fs(20, 15),
      align_h: hmUI.align.LEFT,
      align_v: hmUI.align.CENTER_V,
      text: t('labelFrom', 'FROM')
    })

    hmUI.createWidget(hmUI.widget.BUTTON, {
      x: px(128),
      y: px(curY),
      w: px(66),
      h: px(60),
      radius: px(16),
      text_size: fs(32, 24),
      color: COLORS.WHITE,
      normal_color: COLORS.BTN_NORMAL,
      press_color: COLORS.BTN_PRESS,
      text: '-',
      click_func: () => {
        const nextStart = (this.state.config.startHour + 23) % 24
        this.applyConfigChange({ startHour: nextStart, allDay: false }, false, true)
      }
    })

    w.textStartHour = makeText({
      x: px(198),
      y: px(curY),
      w: px(174),
      h: px(60),
      color: COLORS.WHITE,
      text_size: hourTextSize,
      align_h: hmUI.align.CENTER_H,
      align_v: hmUI.align.CENTER_V,
      text: formatHour(cfg.startHour)
    })

    hmUI.createWidget(hmUI.widget.BUTTON, {
      x: px(376),
      y: px(curY),
      w: px(70),
      h: px(60),
      radius: px(16),
      text_size: fs(32, 24),
      color: COLORS.WHITE,
      normal_color: COLORS.BTN_NORMAL,
      press_color: COLORS.BTN_PRESS,
      text: '+',
      click_func: () => {
        const nextStart = (this.state.config.startHour + 1) % 24
        this.applyConfigChange({ startHour: nextStart, allDay: false }, false, true)
      }
    })
    curY += 74

    // End Hour Row ("TO")
    hmUI.createWidget(hmUI.widget.TEXT, {
      x: px(32),
      y: px(curY),
      w: px(92),
      h: px(60),
      color: COLORS.GRAY,
      text_size: fs(20, 15),
      align_h: hmUI.align.LEFT,
      align_v: hmUI.align.CENTER_V,
      text: t('labelTo', 'TO')
    })

    hmUI.createWidget(hmUI.widget.BUTTON, {
      x: px(128),
      y: px(curY),
      w: px(66),
      h: px(60),
      radius: px(16),
      text_size: fs(32, 24),
      color: COLORS.WHITE,
      normal_color: COLORS.BTN_NORMAL,
      press_color: COLORS.BTN_PRESS,
      text: '-',
      click_func: () => {
        const nextEnd = (this.state.config.endHour + 23) % 24
        this.applyConfigChange({ endHour: nextEnd, allDay: false }, false, true)
      }
    })

    w.textEndHour = makeText({
      x: px(198),
      y: px(curY),
      w: px(174),
      h: px(60),
      color: COLORS.WHITE,
      text_size: hourTextSize,
      align_h: hmUI.align.CENTER_H,
      align_v: hmUI.align.CENTER_V,
      text: formatHour(cfg.endHour)
    })

    hmUI.createWidget(hmUI.widget.BUTTON, {
      x: px(376),
      y: px(curY),
      w: px(70),
      h: px(60),
      radius: px(16),
      text_size: fs(32, 24),
      color: COLORS.WHITE,
      normal_color: COLORS.BTN_NORMAL,
      press_color: COLORS.BTN_PRESS,
      text: '+',
      click_func: () => {
        const nextEnd = (this.state.config.endHour + 1) % 24
        this.applyConfigChange({ endHour: nextEnd, allDay: false }, false, true)
      }
    })
    curY += 80

    // 8. System Silent Modes (DND / Sleep / Theater) — 2 independent toggles
    hmUI.createWidget(hmUI.widget.TEXT, {
      x: px(34),
      y: px(curY),
      w: px(412),
      h: px(28),
      color: COLORS.GRAY,
      text_size: fs(18, 14),
      align_h: hmUI.align.CENTER_H,
      align_v: hmUI.align.CENTER_V,
      text: t('secSilentModes', 'DND / SLEEP / THEATER')
    })
    curY += 34

    if (hasAnySound) {
      w.btnDndSound = makeButton({
        x: px(34),
        y: px(curY),
        w: px(202),
        h: px(70),
        radius: px(18),
        text_size: fs(18, 14),
        color: COLORS.WHITE,
        normal_color: COLORS.ORANGE,
        press_color: COLORS.ORANGE_PRESS,
        text: `● ${t('dndSound', 'Mute Audio')}`,
        click_func: () => {
          this.applyConfigChange(
            { respectDndSound: !this.state.config.respectDndSound },
            true,
            false
          )
        }
      })
    } else {
      w.btnDndSound = makeButton({
        x: px(34),
        y: px(curY),
        w: px(202),
        h: px(70),
        radius: px(18),
        text_size: fs(18, 14),
        color: COLORS.TEXT_DISABLED,
        normal_color: COLORS.BTN_DISABLED,
        press_color: COLORS.BTN_DISABLED,
        text: `× ${t('dndSound', 'Mute Audio')}`,
        click_func: () => {}
      })
    }

    if (hasVibrator) {
      w.btnDndVibrate = makeButton({
        x: px(244),
        y: px(curY),
        w: px(202),
        h: px(70),
        radius: px(18),
        text_size: fs(18, 14),
        color: COLORS.WHITE,
        normal_color: COLORS.ORANGE,
        press_color: COLORS.ORANGE_PRESS,
        text: `● ${t('dndVibrate', 'Mute Vibr.')}`,
        click_func: () => {
          this.applyConfigChange(
            { respectDndVibrate: !this.state.config.respectDndVibrate },
            true,
            false
          )
        }
      })
    } else {
      w.btnDndVibrate = makeButton({
        x: px(244),
        y: px(curY),
        w: px(202),
        h: px(70),
        radius: px(18),
        text_size: fs(18, 14),
        color: COLORS.TEXT_DISABLED,
        normal_color: COLORS.BTN_DISABLED,
        press_color: COLORS.BTN_DISABLED,
        text: `× ${t('dndVibrate', 'Mute Vibr.')}`,
        click_func: () => {}
      })
    }
    curY += 88

    // 9. Test Active Channels Button
    hmUI.createWidget(hmUI.widget.BUTTON, {
      x: px(60),
      y: px(curY),
      w: px(360),
      h: px(72),
      radius: px(36),
      text_size: fs(22, 16),
      color: COLORS.WHITE,
      normal_color: COLORS.BLUE,
      press_color: COLORS.BLUE_PRESS,
      text: t('btnTest', 'TEST CHIME'),
      click_func: () => {
        playHourlyChime(this.state.config, { isBackground: false })
        if (this.state.debugUnlocked) this.refreshDebugLog()
      }
    })
    curY += 88

    // 10. Footer with Device Name & Version (10 taps dynamically spawns Diagnostic Panel)
    w.btnFooter = makeButton({
      x: px(54),
      y: px(curY),
      w: px(372),
      h: px(54),
      radius: px(16),
      color: COLORS.DIM_GRAY,
      normal_color: COLORS.BG_DARK,
      press_color: COLORS.BTN_DISABLED,
      text_size: fs(18, 14),
      text: `${deviceName} • ${APP_VERSION_LABEL}`,
      click_func: () => {
        this.handleFooterTap()
      }
    })
    curY += 64

    this.state.debugBaseY = curY

    // Compact safe bottom spacer (zero blank 250px scroll gap in normal mode)
    hmUI.createWidget(hmUI.widget.FILL_RECT, {
      x: 0,
      y: px(curY),
      w: px(480),
      h: px(isSquare ? 20 : 72),
      color: COLORS.BG_DARK,
      alpha: 0
    })

    // Initial schedule sync + visual refresh
    const res = syncBackgroundSchedule(cfg, true)
    this.state.alarmError = Boolean(cfg.enabled && hasAnyActiveChannel(cfg, caps) && !res.ok)
    this.refreshUI()
  },

  buildDebugPanel() {
    if (this.state.debugBuilt || this.state.destroyed) return
    this.state.debugBuilt = true

    const w = this.state.widgets
    let curY = this.state.debugBaseY

    w.btnDebugTest15s = makeButton({
      x: px(60),
      y: px(curY),
      w: px(360),
      h: px(60),
      radius: px(20),
      text_size: fs(19, 14),
      color: COLORS.WHITE,
      normal_color: COLORS.BTN_NORMAL,
      press_color: COLORS.BTN_PRESS,
      text: t('btnTestBg15s', 'BG TEST (15s)'),
      click_func: () => {
        flushPendingConfigSave()
        const ok = scheduleTestAlarm15s()
        this.state.bgTestScheduled = ok
        this.refreshUI()
      }
    })
    curY += 70

    w.btnDebugReset = makeButton({
      x: px(60),
      y: px(curY),
      w: px(360),
      h: px(56),
      radius: px(20),
      text_size: fs(18, 14),
      color: COLORS.WHITE,
      normal_color: COLORS.BTN_VARIANT,
      press_color: COLORS.BTN_VARIANT_PRESS,
      text: 'RESET AUDIO & ALARM',
      click_func: () => {
        releaseAllAudioHandles()
        this.state.bgTestScheduled = false
        const cfg = loadConfig()
        this.state.config = cfg
        const res = syncBackgroundSchedule(cfg, false)
        this.state.alarmError = Boolean(
          cfg.enabled && hasAnyActiveChannel(cfg, this.state.caps) && !res.ok
        )
        this.refreshUI()
      }
    })
    curY += 66

    w.textDebugLog = makeText({
      x: px(24),
      y: px(curY),
      w: px(432),
      h: px(112),
      color: COLORS.GRAY,
      text_size: fs(15, 13),
      align_h: hmUI.align.CENTER_H,
      align_v: hmUI.align.CENTER_V,
      text_style: hmUI.text_style.WRAP,
      text: 'BG: ---'
    })
    curY += 120

    hmUI.createWidget(hmUI.widget.FILL_RECT, {
      x: 0,
      y: px(curY),
      w: px(480),
      h: px(this.state.isSquare ? 20 : 64),
      color: COLORS.BG_DARK,
      alpha: 0
    })
  },

  refreshDebugLog() {
    const w = this.state.widgets
    if (!w.textDebugLog || this.state.destroyed) return
    const { hasBuzzer, hasSpeaker, hasVibrator } = this.state.caps
    const hwTag = `HW:B${hasBuzzer ? 1 : 0}S${hasSpeaker ? 1 : 0}V${hasVibrator ? 1 : 0}`
    const diag = getBackgroundDiagnostics()
    const silent = getSystemSilentMode()
    const uiDiag = getLastUiDiag()
    const rt = loadRuntimeState()
    const silentTag = silent.isQuiet ? ` ${silent.tag}` : ''
    const line1 = uiDiag ? `${diag} ${hwTag}${silentTag}\n${uiDiag}` : `${diag} ${hwTag}${silentTag}`
    const line2 = rt.lastBgLog ? `BG: ${rt.lastBgLog}` : 'BG: ---'
    w.textDebugLog.update({
      text: `${line1}\n${line2}`
    })
  },

  handleFooterTap() {
    if (this.state.debugUnlocked) {
      this.state.config = loadConfig()
      this.refreshUI()
      return
    }

    this.state.footerTapCount += 1
    const remaining = DEBUG_UNLOCK_TAPS - this.state.footerTapCount

    if (remaining <= 0) {
      this.state.debugUnlocked = true
      this.state.footerTapCount = 0
      this.buildDebugPanel()
      this.refreshUI()
    } else if (remaining <= 3) {
      this.state.widgets.btnFooter.update({
        text: `${this.state.deviceName} • ${APP_VERSION_LABEL} (${remaining})`
      })
    }
  },

  cycleBuzzerVariant(delta) {
    if (!this.state.caps.hasBuzzer) return
    const idx = findVariantIndex(BUZZER_VARIANTS, this.state.config.buzzerVariant)
    const nextIdx = (idx + delta + BUZZER_VARIANTS.length) % BUZZER_VARIANTS.length
    const nextId = BUZZER_VARIANTS[nextIdx].id
    this.applyConfigChange({ buzzerVariant: nextId }, false, false)
    previewBuzzerVariant(nextId, this.state.config.buzzerRepeats, this.state.config.buzzerGapMs)
    if (this.state.debugUnlocked) this.refreshDebugLog()
  },

  stepBuzzerRepeats(delta) {
    if (!this.state.caps.hasBuzzer) return
    const current = Number(this.state.config.buzzerRepeats)
    const next = Math.max(0, Math.min(BUZZER_REPEAT_LEVELS.length - 1, current + delta))
    this.applyConfigChange({ buzzerRepeats: next }, false, false)
    previewBuzzerVariant(this.state.config.buzzerVariant, next, this.state.config.buzzerGapMs)
    if (this.state.debugUnlocked) this.refreshDebugLog()
  },

  stepBuzzerGap(direction) {
    if (!this.state.caps.hasBuzzer) return
    const current = Number(this.state.config.buzzerGapMs) || 0
    let next
    if (direction < 0) {
      if (current <= BUZZER_GAP_MIN_MS) {
        next = 0
      } else {
        next = Math.max(BUZZER_GAP_MIN_MS, current - BUZZER_GAP_STEP_MS)
      }
    } else {
      if (current <= 0) {
        next = BUZZER_GAP_MIN_MS
      } else {
        next = Math.min(BUZZER_GAP_MAX_MS, current + BUZZER_GAP_STEP_MS)
      }
    }
    this.applyConfigChange({ buzzerGapMs: next }, false, false)
    previewBuzzerVariant(this.state.config.buzzerVariant, this.state.config.buzzerRepeats, next)
    if (this.state.debugUnlocked) this.refreshDebugLog()
  },

  cycleSpeakerVariant(delta) {
    if (!this.state.caps.hasSpeaker) return
    const idx = findVariantIndex(SPEAKER_VARIANTS, this.state.config.speakerVariant)
    const nextIdx = (idx + delta + SPEAKER_VARIANTS.length) % SPEAKER_VARIANTS.length
    const nextId = SPEAKER_VARIANTS[nextIdx].id
    this.applyConfigChange({ speakerVariant: nextId }, false, false)
    previewSpeakerVariant(nextId, this.state.config.speakerVolume)
  },

  stepSpeakerVolume(direction) {
    if (!this.state.caps.hasSpeaker) return
    const current = Number(this.state.config.speakerVolume)
    let next
    if (direction < 0) {
      if (current <= 20) {
        next = Math.max(1, current - 1)
      } else {
        const rem = current % 5
        next = rem === 0 ? current - 5 : current - rem
        next = Math.max(20, next)
      }
    } else {
      if (current < 20) {
        next = Math.min(20, current + 1)
      } else {
        const rem = current % 5
        next = rem === 0 ? current + 5 : current + (5 - rem)
        next = Math.min(100, next)
      }
    }
    this.applyConfigChange({ speakerVolume: next }, false, false)
    previewSpeakerVariant(this.state.config.speakerVariant, next)
  },

  cycleVibrateMode(delta) {
    if (!this.state.caps.hasVibrator) return
    const idx = findVariantIndex(VIBRATE_MODES, this.state.config.vibrateMode)
    const nextIdx = (idx + delta + VIBRATE_MODES.length) % VIBRATE_MODES.length
    const nextId = VIBRATE_MODES[nextIdx].id
    this.applyConfigChange({ vibrateMode: nextId }, false, false)
    previewVibrateMode(nextId, this.state.config.vibrateStrength)
  },

  stepVibrateStrength(delta) {
    if (!this.state.caps.hasVibrator) return
    const current = Number(this.state.config.vibrateStrength)
    const next = Math.max(0, Math.min(VIBRATE_STRENGTHS.length - 1, current + delta))
    this.applyConfigChange({ vibrateStrength: next }, false, false)
    previewVibrateMode(this.state.config.vibrateMode, next)
  },

  applyConfigChange(partial, immediateSave = true, syncAlarm = false) {
    const updated = updateConfig(partial, this.state.config, immediateSave)
    this.state.config = updated
    if (syncAlarm) {
      const res = syncBackgroundSchedule(updated, true)
      this.state.alarmError = Boolean(
        updated.enabled && hasAnyActiveChannel(updated, this.state.caps) && !res.ok
      )
    }
    this.refreshUI()
  },

  refreshUI() {
    if (this.state.destroyed) return
    const cfg = this.state.config
    const w = this.state.widgets
    const { hasBuzzer, hasSpeaker, hasVibrator } = this.state.caps
    const hasAnySound = hasBuzzer || hasSpeaker

    // Status Header
    const nextLabel = getNextChimeLabel(cfg)
    const activeChannels = []
    if (hasBuzzer && cfg.buzzerEnabled) activeChannels.push(t('shortBuz', 'Buz'))
    if (hasSpeaker && cfg.speakerEnabled) activeChannels.push(t('shortSpk', 'Spk'))
    if (hasVibrator && cfg.vibrateEnabled) activeChannels.push(t('shortVib', 'Vib'))

    let statusLine = t('statusOff', 'Chime disabled')
    let statusColor = COLORS.DIM_GRAY
    if (this.state.bgTestScheduled) {
      statusLine = t('statusBgTestSet', 'BG test in 15s...')
      statusColor = COLORS.GREEN_PRESS
    } else if (cfg.enabled) {
      if (activeChannels.length === 0) {
        statusLine = t('statusPickChannel', 'Enable at least 1 channel!')
        statusColor = COLORS.ORANGE
      } else if (this.state.alarmError) {
        statusLine = t('statusAlarmErr', 'Alarm schedule error!')
        statusColor = COLORS.RED_PRESS
      } else {
        statusLine = `${t('statusNext', 'Next:')} ${nextLabel} (${activeChannels.join('+')})`
        statusColor = COLORS.ORANGE
      }
    }

    w.statusText.update({
      text: statusLine,
      color: statusColor
    })

    // Master Button
    w.masterBtn.update({
      text: cfg.enabled ? t('masterOn', '●  ACTIVE (ON)') : t('masterOff', '○  DISABLED'),
      normal_color: cfg.enabled ? COLORS.GREEN : COLORS.BTN_NORMAL,
      press_color: cfg.enabled ? COLORS.GREEN_PRESS : COLORS.BTN_PRESS
    })

    // Channel Toggle Buttons
    const lblBuz = t('chBuzzer', 'BUZZER')
    const lblSpk = t('chSpeaker', 'SPEAKER')
    const lblVib = t('chVibrate', 'VIBR.')

    if (hasBuzzer) {
      w.btnBuzzerToggle.update({
        text: cfg.buzzerEnabled ? `● ${lblBuz}` : `○ ${lblBuz}`,
        color: COLORS.WHITE,
        normal_color: cfg.buzzerEnabled ? COLORS.ORANGE : COLORS.BTN_NORMAL,
        press_color: cfg.buzzerEnabled ? COLORS.ORANGE_PRESS : COLORS.BTN_PRESS
      })
      if (w.textSysBuzzerWarn) {
        w.textSysBuzzerWarn.setVisible(cfg.buzzerEnabled && !this.state.sysBuzzerEnabled)
      }
    } else {
      w.btnBuzzerToggle.update({
        text: `× ${lblBuz}`,
        color: COLORS.TEXT_DISABLED,
        normal_color: COLORS.BTN_DISABLED,
        press_color: COLORS.BTN_DISABLED
      })
    }

    if (hasSpeaker) {
      w.btnSpeakerToggle.update({
        text: cfg.speakerEnabled ? `● ${lblSpk}` : `○ ${lblSpk}`,
        color: COLORS.WHITE,
        normal_color: cfg.speakerEnabled ? COLORS.ORANGE : COLORS.BTN_NORMAL,
        press_color: cfg.speakerEnabled ? COLORS.ORANGE_PRESS : COLORS.BTN_PRESS
      })
    } else {
      w.btnSpeakerToggle.update({
        text: `× ${lblSpk}`,
        color: COLORS.TEXT_DISABLED,
        normal_color: COLORS.BTN_DISABLED,
        press_color: COLORS.BTN_DISABLED
      })
    }

    if (hasVibrator) {
      w.btnVibrateToggle.update({
        text: cfg.vibrateEnabled ? `● ${lblVib}` : `○ ${lblVib}`,
        color: COLORS.WHITE,
        normal_color: cfg.vibrateEnabled ? COLORS.ORANGE : COLORS.BTN_NORMAL,
        press_color: cfg.vibrateEnabled ? COLORS.ORANGE_PRESS : COLORS.BTN_PRESS
      })
    } else {
      w.btnVibrateToggle.update({
        text: `× ${lblVib}`,
        color: COLORS.TEXT_DISABLED,
        normal_color: COLORS.BTN_DISABLED,
        press_color: COLORS.BTN_DISABLED
      })
    }

    // Hardware Buzzer Variant + Repeats + Gap
    if (hasBuzzer && w.btnBuzzerName && w.btnBuzzerRepeats) {
      const buzzerIdx = findVariantIndex(BUZZER_VARIANTS, cfg.buzzerVariant)
      const bv = BUZZER_VARIANTS[buzzerIdx]
      w.btnBuzzerName.update({
        text: t(bv.i18nKey, bv.fallback),
        color: cfg.buzzerEnabled ? COLORS.ORANGE : COLORS.GRAY
      })
      w.btnBuzzerRepeats.update({
        text: `${t('repeatsPrefix', 'Repeats:')} ${getRepeatLabel(cfg.buzzerRepeats)}`,
        color: cfg.buzzerEnabled ? COLORS.WHITE : COLORS.GRAY
      })
      if (w.btnBuzzerGap) {
        const gapVal = cfg.buzzerGapMs > 0 ? `${cfg.buzzerGapMs} ms` : t('gapAuto', 'Auto')
        w.btnBuzzerGap.update({
          text: `${t('gapPrefix', 'Gap:')} ${gapVal}`,
          color: cfg.buzzerEnabled && cfg.buzzerRepeats > 0 ? COLORS.WHITE : COLORS.GRAY
        })
      }
    }

    // Speaker Variant + Volume
    if (hasSpeaker && w.btnSpeakerName && w.btnSpeakerVol) {
      const speakerIdx = findVariantIndex(SPEAKER_VARIANTS, cfg.speakerVariant)
      const sv = SPEAKER_VARIANTS[speakerIdx]
      w.btnSpeakerName.update({
        text: t(sv.i18nKey, sv.fallback),
        color: cfg.speakerEnabled ? COLORS.ORANGE : COLORS.GRAY
      })
      w.btnSpeakerVol.update({
        text: `${t('volumePrefix', 'Volume:')} ${cfg.speakerVolume}%`,
        color: cfg.speakerEnabled ? COLORS.WHITE : COLORS.GRAY
      })
    }

    // Vibration Mode + Strength
    if (hasVibrator && w.btnVibrateName && w.btnVibrateStrength) {
      const vibIdx = findVariantIndex(VIBRATE_MODES, cfg.vibrateMode)
      const vm = VIBRATE_MODES[vibIdx]
      w.btnVibrateName.update({
        text: t(vm.i18nKey, vm.fallback),
        color: cfg.vibrateEnabled ? COLORS.ORANGE : COLORS.GRAY
      })
      w.btnVibrateStrength.update({
        text: `${t('powerPrefix', 'Power:')} ${getVibrateStrengthLabel(cfg.vibrateStrength)}`,
        color: cfg.vibrateEnabled ? COLORS.WHITE : COLORS.GRAY
      })
    }

    // All Day Button
    w.btnAllDay.update({
      text: cfg.allDay
        ? t('modeAllDay', 'Mode: ALL DAY (24H)')
        : t('modeRange', 'Mode: HOUR RANGE'),
      normal_color: cfg.allDay ? COLORS.ORANGE : COLORS.BTN_NORMAL,
      press_color: cfg.allDay ? COLORS.ORANGE_PRESS : COLORS.BTN_PRESS
    })

    // Hours Text (dynamically adapts font size & format for 12H AM/PM vs 24H)
    const hourColor = cfg.allDay ? COLORS.DIM_GRAY : COLORS.WHITE
    const hourSize = is12HourFormat() ? fs(26, 19) : fs(32, 24)
    w.textStartHour.update({
      text: formatHour(cfg.startHour),
      color: hourColor,
      text_size: hourSize
    })
    w.textEndHour.update({
      text: formatHour(cfg.endHour),
      color: hourColor,
      text_size: hourSize
    })

    // Independent DND / Sleep / Theater Toggle Buttons
    const lblDndSound = t('dndSound', 'Mute Audio')
    const lblDndVib = t('dndVibrate', 'Mute Vibr.')

    if (hasAnySound) {
      w.btnDndSound.update({
        text: cfg.respectDndSound ? `● ${lblDndSound}` : `○ ${lblDndSound}`,
        color: COLORS.WHITE,
        normal_color: cfg.respectDndSound ? COLORS.ORANGE : COLORS.BTN_NORMAL,
        press_color: cfg.respectDndSound ? COLORS.ORANGE_PRESS : COLORS.BTN_PRESS
      })
    } else {
      w.btnDndSound.update({
        text: `× ${lblDndSound}`,
        color: COLORS.TEXT_DISABLED,
        normal_color: COLORS.BTN_DISABLED,
        press_color: COLORS.BTN_DISABLED
      })
    }

    if (hasVibrator) {
      w.btnDndVibrate.update({
        text: cfg.respectDndVibrate ? `● ${lblDndVib}` : `○ ${lblDndVib}`,
        color: COLORS.WHITE,
        normal_color: cfg.respectDndVibrate ? COLORS.ORANGE : COLORS.BTN_NORMAL,
        press_color: cfg.respectDndVibrate ? COLORS.ORANGE_PRESS : COLORS.BTN_PRESS
      })
    } else {
      w.btnDndVibrate.update({
        text: `× ${lblDndVib}`,
        color: COLORS.TEXT_DISABLED,
        normal_color: COLORS.BTN_DISABLED,
        press_color: COLORS.BTN_DISABLED
      })
    }

    // Footer + Optional Dynamic Diagnostic Panel
    w.btnFooter.update({
      text: this.state.debugUnlocked
        ? `${this.state.deviceName} • ${APP_VERSION_LABEL} [DBG]`
        : `${this.state.deviceName} • ${APP_VERSION_LABEL}`
    })

    if (this.state.debugUnlocked && this.state.debugBuilt) {
      w.btnDebugTest15s.update({
        normal_color: this.state.bgTestScheduled ? COLORS.GREEN : COLORS.BTN_NORMAL,
        press_color: this.state.bgTestScheduled ? COLORS.GREEN_PRESS : COLORS.BTN_PRESS
      })
      this.refreshDebugLog()
    }
  },

  onDestroy() {
    this.state.destroyed = true
    flushPendingConfigSave()
    releaseAllAudioHandles()
    this.state.widgets = {}
  }
})
