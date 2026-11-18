import { releaseAllAudioHandles } from '../utils/audio'
import { handleBackgroundWakeup } from '../utils/schedule'

AppService({
  onInit(params) {
    // Pure Single Execution woken exclusively by hardware RTC @zos/alarm (0 B RAM between hours)
    handleBackgroundWakeup(params)
  },

  onEvent(params) {
    handleBackgroundWakeup(params)
  },

  onDestroy() {
    releaseAllAudioHandles({ keepActiveHardware: true })
  }
})
