/**
 * UI-only variant catalog (imported solely by UI pages, never by AppService/App).
 * Keeps background service bytecode and RAM footprint minimal.
 */
export const BUZZER_VARIANTS = [
  { id: 'hw_operate', i18nKey: 'hw_1', fallback: '1/6 Click' },
  { id: 'hw_remind1', i18nKey: 'hw_2', fallback: '2/6 Remind 1' },
  { id: 'hw_remind2', i18nKey: 'hw_3', fallback: '3/6 Remind 2' },
  { id: 'hw_alarm', i18nKey: 'hw_4', fallback: '4/6 Alarm' },
  { id: 'hw_success', i18nKey: 'hw_5', fallback: '5/6 Success' },
  { id: 'hw_failure', i18nKey: 'hw_6', fallback: '6/6 Alert' }
]

export const BUZZER_REPEAT_LEVELS = [
  { level: 0, label: '1x', repeatCount: 0 },
  { level: 1, label: '2x', repeatCount: 1 },
  { level: 2, label: '3x', repeatCount: 2 },
  { level: 3, label: '4x', repeatCount: 3 }
]

export const SPEAKER_VARIANTS = [
  { id: 'retro_1989', i18nKey: 'spk_1', fallback: '1/18 Retro 1989' },
  { id: 'retro_fast', i18nKey: 'spk_2', fallback: '2/18 Retro Quick' },
  { id: 'retro_steel', i18nKey: 'spk_3', fallback: '3/18 Retro Steel' },
  { id: 'vintage_2k4k', i18nKey: 'spk_4', fallback: '4/18 Vintage 2k+4k' },
  { id: 'single_crisp', i18nKey: 'spk_5', fallback: '5/18 Single Crisp' },
  { id: 'triple_3x', i18nKey: 'spk_6', fallback: '6/18 Triple 3x' },
  { id: 'double_pair', i18nKey: 'spk_7', fallback: '7/18 Double 2x2' },
  { id: 'dual_up', i18nKey: 'spk_8', fallback: '8/18 Dual Up' },
  { id: 'dual_down', i18nKey: 'spk_9', fallback: '9/18 Dual Down' },
  { id: 'triad_3note', i18nKey: 'spk_10', fallback: '10/18 3-Note Chime' },
  { id: 'soft_bell', i18nKey: 'spk_11', fallback: '11/18 Soft Bell' },
  { id: 'tactical_ping', i18nKey: 'spk_12', fallback: '12/18 Tactical Ping' },
  { id: 'retro_500_4k', i18nKey: 'spk_13', fallback: '13/18 Piezo 4k 500ms' },
  { id: 'retro_500_2k', i18nKey: 'spk_14', fallback: '14/18 Piezo 2k 500ms' },
  { id: 'retro_500_32k', i18nKey: 'spk_15', fallback: '15/18 Piezo 3.2k 500' },
  { id: 'retro_500_27k', i18nKey: 'spk_16', fallback: '16/18 Piezo 2.7k 500' },
  { id: 'retro_500_4k_short', i18nKey: 'spk_17', fallback: '17/18 Piezo 4k Sharp' },
  { id: 'retro_500_dual', i18nKey: 'spk_18', fallback: '18/18 Piezo Dual 500' }
]

export const VIBRATE_MODES = [
  { id: 'double_short', i18nKey: 'vib_1', fallback: '1/7 2x Short' },
  { id: 'double_crown', i18nKey: 'vib_2', fallback: '2/7 2x Crown' },
  { id: 'triple_short', i18nKey: 'vib_3', fallback: '3/7 3x Fast' },
  { id: 'short_long', i18nKey: 'vib_4', fallback: '4/7 Short+Long' },
  { id: 'long_short', i18nKey: 'vib_5', fallback: '5/7 Long+Short' },
  { id: 'single_pulse', i18nKey: 'vib_6', fallback: '6/7 1x Single' },
  { id: 'notify_hw', i18nKey: 'vib_7', fallback: '7/7 System 2x' }
]

export const VIBRATE_STRENGTHS = [
  { level: 0, i18nKey: 'strWeak', fallback: 'Light' },
  { level: 1, i18nKey: 'strMedium', fallback: 'Medium' },
  { level: 2, i18nKey: 'strStrong', fallback: 'Strong' }
]
