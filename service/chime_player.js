import * as appService from '@zos/app-service'
import { releaseAllAudioHandles } from '../utils/audio'
import { handlePlayerServiceInit } from '../utils/schedule'

let exited = false
let hardWatchdogId = null

function clearHardWatchdog() {
  if (hardWatchdogId !== null) {
    try {
      clearTimeout(hardWatchdogId)
    } catch (e) {}
    hardWatchdogId = null
  }
}

function exitPlayerCleanly() {
  if (exited) return
  exited = true
  clearHardWatchdog()
  releaseAllAudioHandles({ keepActiveHardware: true })
  try {
    if (appService && typeof appService.exit === 'function') {
      appService.exit()
    }
  } catch (e) {}
}

AppService({
  onInit(params) {
    exited = false
    clearHardWatchdog()
    // Hard 5s safety ceiling so this short-lived player service can never remain in RAM
    hardWatchdogId = setTimeout(exitPlayerCleanly, 5000)
    handlePlayerServiceInit(params, exitPlayerCleanly)
  },

  onDestroy() {
    exited = true
    clearHardWatchdog()
    releaseAllAudioHandles({ keepActiveHardware: true })
  }
})
