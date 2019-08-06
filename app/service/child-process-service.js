// @flow
/* eslint-disable global-require */
import * as fs from 'fs'
import path from 'path'
import log from 'electron-log'
import { spawn } from 'child_process'
import { remote } from 'electron'
import ps from 'ps-node'
import { take, filter, switchMap } from 'rxjs/operators'
import { race } from 'rxjs'
import { ofType } from 'redux-observable'

import { translate } from '~/i18next.config'
import { getStore } from '~/store/configureStore'
import { getOS, getAppDataPath, getBinariesPath } from '~/utils/os'


const t = translate('service')

/**
 * ES6 singleton
 */
let instance = null

export type ChildProcessName = 'NODE'
export type ChildProcessStatus = 'RUNNING' | 'STARTING' | 'RESTARTING' | 'FAILED' | 'STOPPING' | 'MURDER FAILED' | 'NOT RUNNING'

const childProcessCommands = {
  NODE: 'cloakcoind'
}

/**
 * @export
 * @class ChildProcessService
 */
export class ChildProcessService {
	/**
	 * Creates an instance of ChildProcessService.
	 * @memberof ChildProcessService
	 */
	constructor() {
    if (!instance) {
      instance = this
    }

		return instance
	}

  getStatusName(processStatus) {
    const nameMap = {
      'RUNNING' : t(`Running`),
      'STARTING' : t(`Starting`),
      'RESTARTING' : t(`Restarting`),
      'FAILED' : t(`Failed`),
      'STOPPING' : t(`Stopping`),
      'MURDER FAILED' : t(`Murder failed`),
      'NOT RUNNING' : t(`Not running`)
    }
    return nameMap[processStatus] || t(`Unknown`)
  }

  getObservable({processName, onSuccess, onFailure, action$}) {
    const actions = this.getSettingsActions()

    const observable = race(
      action$.pipe(
        ofType(actions.childProcessStarted),
        filter(action => action.payload.processName === processName),
          take(1),
        switchMap(() => onSuccess)
      ),
      action$.pipe(
        ofType(actions.childProcessFailed),
        filter(action => action.payload.processName === processName),
          take(1),
        switchMap(() => onFailure)
      )
    )

    return observable
  }

	/**
	 * Returns child process status alarm color, 'green', 'red' or 'yellow'
   *
	 * @param {Object} action
	 * @memberof RpcService
	 */
  getChildProcessStatusColor(processStatus) {
    switch (processStatus) {
      case 'RUNNING':
        return 'green'
      case 'STARTING':
      case 'RESTARTING':
      case 'STOPPING':
        return 'yellow'
      case 'NOT RUNNING':
      case 'FAILED':
      case 'MURDER FAILED':
        return 'red'
      default:
    }
  }

	/**
   * Avoid circular dependency in types.js
   *
	 * @returns {SettingsActions}
	 * @memberof ChildProcessService
	 */
  getSettingsActions() {
    const settingsReducerModule = require('~/reducers/settings/settings.reducer')
    return settingsReducerModule.SettingsActions
  }

  getLogFilePath(processName: string) {
    const command = childProcessCommands[processName]
    return  path.join(getAppDataPath(), `${command}.log`)
  }

	/**
   * Restarts a child process by name using killProcess() and execProcess() methods.
   *
	 * @param {options} execProcess() options
	 * @memberof ChildProcessService
	 */
  async restartProcess(options) {
    log.info(`Restarting ${options.processName} process.`)

    await this.killProcess(options.processName)
    await this.execProcess(options)
  }

	/**
   * Starts a child process with a given name and sends status update messages.
   *
	 * @param {string} processName
	 * @param {string[]} args
	 * @param {function} outputHandler If returns true the process is considered started.
	 * @memberof ChildProcessService
	 */
  async execProcess({processName, args = [], outputHandler, spawnOptions = {}, waitUntilReady}) {
    const childProcessInfo = remote.getGlobal('childProcesses')[processName]
    const actions = this.getSettingsActions()

    await this.killProcess(processName)

    const childProcess = this::spawnProcess(processName, args, spawnOptions)

    childProcessInfo.instance = childProcess

    this::initLogging(childProcess, processName)

    childProcess.on('error', err => {
      log.error(`Process ${processName} has failed!`)
      getStore().dispatch(actions.childProcessFailed(processName, err.toString()))
    })

    childProcess.on('close', code => {
      if (!childProcessInfo.isGettingKilled) {
        const errorMessage =  t(`Process {{processName}} unexpectedly exited with code {{code}}.`, { processName, code })
        getStore().dispatch(actions.childProcessFailed(processName, errorMessage))
      }
      childProcessInfo.isGettingKilled = false
    })

    await this::initAndWaitForFirstOutput(childProcess, outputHandler)

    if (waitUntilReady) {
      try {
        await waitUntilReady()
      } catch(err) {
        getStore().dispatch(actions.childProcessFailed(processName, err.message))
        return
      }
    }

    getStore().dispatch(actions.childProcessStarted(processName))
    childProcessInfo.pid = await this.getPid(childProcessCommands[processName])

  }

	/**
   * Kills a child process by name and sends status update messages.
   * Provide customSuccessHandler to suppress CHILD_PROCESS_MURDERED message.
   *
	 * @param {string} processName
	 * @param {function} customSuccessHandler
   * @returns {Promise}
	 * @memberof ChildProcessService
	 */
  async killProcess(processName: ChildProcessName) {
    const actions = this.getSettingsActions()

    try {
      const pid = await this.getPid(childProcessCommands[processName])

      if (pid) {
        const childProcessInfo = remote.getGlobal('childProcesses')[processName]
        childProcessInfo.isGettingKilled = true
        await this.killPid(pid)
      } else {
        log.warn(`Process ${processName} isn't running`)
      }

      getStore().dispatch(actions.childProcessMurdered(processName))
    } catch(err) {
      log.error(`Process murder failed`, err)
      getStore().dispatch(actions.childProcessMurderFailed(processName, err.message))
    }
  }

	/**
	 * @param {string} pid
	 * @memberof ChildProcessService
	 * @returns {Promise<any>}
	 */
	async killPid(pid) {
		return new Promise((resolve, reject) => {
			ps.kill(pid, err => {
				if (err) {
					reject(err)
				}
				log.info('Process %s has been killed!', pid)
				resolve(pid)
			})
		})
	}

	/**
	 * @param {string} processName
	 * @memberof ChildProcessService
	 * @returns {Promise<number>}
	 */
	async getPid(processName: string) {
		return new Promise((resolve, reject) => {
			let process

			ps.lookup(
				{
					command: processName
				},
				(err, resultList) => {
					if (err) {
						reject(err)
					}

					[process] = resultList

					if (process) {
						resolve(process.pid)
					} else {
						resolve(0)
						log.info('No such process found!')
					}
				}
			)
		})
	}


  /**
   * Returns a polling function calling checker until it returns true
   *
   * @memberof ChildProcessService
   */
  createReadinessWaiter(checker: () => boolean): () => void {
    const promise = new Promise((resolve, reject) => {
      let interval = setInterval(() => {

        checker().then(isReady => {
          if (isReady) {
            clearInterval(interval)
            interval = null
            setTimeout(resolve, 100)
          }
          return null
        }).catch(err => {
          log.error(`Process status checker async function threw an exception`, err)
          reject(new Error(t(`Unexpected error occurred`)))
        })

      }, 100)

      setTimeout(() => {
        if (interval !== null) {
          clearInterval(interval)
          log.error('Child process startup timed out')
          reject(new Error(`Startup timed out`))
        }
      }, 60000)
    })

    return () => promise
}
}

function spawnProcess(processName, args, spawnOptions) {
  const command = childProcessCommands[processName]
  const commandPath = path.join(getBinariesPath(), command)

  const truncatedArguments = args.join(' ').substring(0, 256)
  log.info(`Executing command ${commandPath} with arguments ${truncatedArguments}.`)

  const options = { ...spawnOptions }

  switch (getOS()) {
    case 'macos':
      options.env = {
        ...process.env,
        DYLD_LIBRARY_PATH: getBinariesPath()
      }
      break

    case 'linux':
      options.env = {
        ...process.env,
        'LD_LIBRARY_PATH': getBinariesPath()
      }
      break

    default:
  }

  const childProcess = spawn(commandPath, args, options)

  return childProcess
}

async function initAndWaitForFirstOutput(childProcess, outputHandler) {
    let isFirstOutputHandled = false

    const promise = new Promise(resolve => {
      const onOutput = (data: Buffer) => {
        if (outputHandler) {
          outputHandler(data)
        }

        if (!isFirstOutputHandled) {
          isFirstOutputHandled = true
          resolve()
        }

      }

      childProcess.stdout.on('data', onOutput)
      childProcess.stderr.on('data', onOutput)
    })

    return promise
}

function initLogging(childProcess, processName) {
  const logFile = this.getLogFilePath(processName)
  const logStream = fs.createWriteStream(logFile, {flags: 'a'})

  childProcess.stdout.pipe(logStream)
  childProcess.stderr.pipe(logStream)
}