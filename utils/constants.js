export const APP_VERSION = '2.3.1'
export const SERVICE_FILE = 'service/hourly_chime'

export const BUZZER_VARIANT_IDS = [
  'hw_operate',
  'hw_remind1',
  'hw_remind2',
  'hw_alarm',
  'hw_success',
  'hw_failure'
]

export const BUZZER_REPEAT_COUNTS = [0, 1, 2, 3]

export const SPEAKER_FILE_MAP = {
  retro_500_4k: 'raw/spk_500_4k.mp3',
  retro_500_2k: 'raw/spk_500_2k.mp3',
  retro_500_32k: 'raw/spk_500_32k.mp3',
  retro_500_27k: 'raw/spk_500_27k.mp3',
  retro_500_4k_short: 'raw/spk_500_4k_short.mp3',
  retro_500_dual: 'raw/spk_500_dual.mp3',
  retro_1989: 'raw/spk_retro_1989.mp3',
  retro_fast: 'raw/spk_retro_fast.mp3',
  retro_steel: 'raw/spk_retro_steel.mp3',
  vintage_2k4k: 'raw/spk_vintage_2k4k.mp3',
  single_crisp: 'raw/spk_single.mp3',
  triple_3x: 'raw/spk_triple.mp3',
  double_pair: 'raw/spk_double_pair.mp3',
  dual_up: 'raw/spk_dual_up.mp3',
  dual_down: 'raw/spk_dual_down.mp3',
  triad_3note: 'raw/spk_triad.mp3',
  soft_bell: 'raw/spk_soft_bell.mp3',
  tactical_ping: 'raw/spk_tactical_ping.mp3'
}

export const SPEAKER_VARIANT_IDS = Object.keys(SPEAKER_FILE_MAP)

export const VIBRATE_MODE_IDS = [
  'double_short',
  'double_crown',
  'triple_short',
  'short_long',
  'long_short',
  'single_pulse',
  'notify_hw'
]

export const DEFAULT_CONFIG = {
  enabled: true,
  buzzerEnabled: true,
  speakerEnabled: false,
  vibrateEnabled: false,
  buzzerVariant: 'hw_operate',
  buzzerRepeats: 1,
  speakerVariant: 'retro_500_4k',
  speakerVolume: 50,
  vibrateMode: 'double_short',
  vibrateStrength: 1,
  allDay: false,
  startHour: 8,
  endHour: 22,
  respectDndSound: true,
  respectDndVibrate: true
}

export const DEFAULT_RUNTIME = {
  lastChimedKey: '',
  lastBgLog: ''
}
