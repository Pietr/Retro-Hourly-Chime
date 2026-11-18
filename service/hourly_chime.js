import { releaseAllAudioHandles } from '../utils/audio'
import { handleBackgroundWakeup } from '../utils/schedule'

AppService({
  onInit(params) {
    // Pure Single Execution woken by @zos/alarm:
    // - Atomic chimes (native Buzzer Auto / Vibrator) fire synchronously in <5 ms.
    // - Async chimes (Speaker MP3 or custom Buzzer Gap) promote to short-lived service/chime_player.
    // Do NOT call appService.exit() inside onInit(), letting Single Execution finish naturally.
    handleBackgroundWakeup(params)
  },

  onDestroy() {
    releaseAllAudioHandles({ keepActiveHardware: true })
  }
})
