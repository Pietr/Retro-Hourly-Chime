import { releaseAllAudioHandles } from '../utils/audio'
import { handleBackgroundWakeup } from '../utils/schedule'

AppService({
  onInit(params) {
    // Zero sensors, zero onPerMinute, zero idle timers — woken exclusively by @zos/alarm
    handleBackgroundWakeup(params)
  },

  onEvent(params) {
    handleBackgroundWakeup(params)
  },

  onDestroy() {
    releaseAllAudioHandles({ keepActiveHardware: true })
  }
})
