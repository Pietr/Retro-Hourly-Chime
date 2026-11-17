import { log as Logger } from '@zos/utils'
import { flushPendingConfigSave, loadConfig } from './utils/storage'
import { releaseAllAudioHandles } from './utils/audio'
import { syncBackgroundSchedule } from './utils/schedule'

const logger = Logger.getLogger('hourly_chime_app')

App({
  globalData: {},

  onCreate() {},

  onDestroy() {
    flushPendingConfigSave()
    releaseAllAudioHandles()
    try {
      const config = loadConfig()
      syncBackgroundSchedule(config, true)
    } catch (e) {
      logger.error('App onDestroy syncBackgroundSchedule error:', e)
    }
  }
})
