import * as appService from '@zos/app-service'
import { releaseAllAudioHandles } from '../utils/audio'
import { handleBackgroundWakeup } from '../utils/schedule'

let exited = false

function exitServiceCleanly() {
  if (exited) return
  exited = true
  releaseAllAudioHandles()
  try {
    if (appService && typeof appService.exit === 'function') {
      appService.exit()
    }
  } catch (e) {}
}

AppService({
  onInit(params) {
    exited = false
    handleBackgroundWakeup(params, exitServiceCleanly)
  },

  onDestroy() {
    exited = true
    releaseAllAudioHandles()
  }
})
