import { EventEmitter } from 'events'
import * as core from '@actions/core'
import * as path from 'path'
import { spawn, ChildProcess } from 'child_process'
import * as main from '../src/main'

jest.mock('child_process', () => ({
  spawn: jest.fn()
}))

type MockGdbProcess = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: {
    write: jest.Mock
  }
  kill: jest.Mock
}

let getInputMock: jest.SpiedFunction<typeof core.getInput>
let setFailedMock: jest.SpiedFunction<typeof core.setFailed>
const spawnMock = jest.mocked(spawn)

function createMockGdbProcess(): MockGdbProcess {
  const processMock = new EventEmitter() as MockGdbProcess

  processMock.stdout = new EventEmitter()
  processMock.stderr = new EventEmitter()
  processMock.stdin = {
    write: jest.fn()
  }
  processMock.kill = jest.fn(() => {
    process.nextTick(() => {
      processMock.emit('close', 0)
    })

    return true
  })

  return processMock
}

describe('action', () => {
  beforeEach(() => {
    jest.clearAllMocks()

    getInputMock = jest.spyOn(core, 'getInput').mockReturnValue('')
    setFailedMock = jest.spyOn(core, 'setFailed').mockImplementation()
  })

  afterEach(() => {
    process.removeAllListeners('SIGINT')
    process.removeAllListeners('SIGTERM')
  })

  it('marks the action as failed for an invalid timeout', async () => {
    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'timeout':
          return '0'
        case 'gdb_target_host':
          return 'localhost:3333'
        case 'executable':
          return 'firmware.elf'
        case 'wait_for_msg':
          return 'DONE'
        default:
          return ''
      }
    })

    await main.run()

    expect(spawnMock).not.toHaveBeenCalled()
    expect(setFailedMock).toHaveBeenCalledWith(
      'Invalid timeout value: 0. Must be a positive number.'
    )
  })

  it('runs gdb and completes when the target message is received', async () => {
    const processMock = createMockGdbProcess()

    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'timeout':
          return '5'
        case 'gdb_target_host':
          return 'localhost:3333'
        case 'executable':
          return 'firmware.elf'
        case 'wait_for_msg':
          return 'DONE'
        default:
          return ''
      }
    })

    spawnMock.mockImplementation(() => {
      process.nextTick(() => {
        processMock.stdout.emit('data', Buffer.from('DONE\n'))
      })

      return processMock as unknown as ChildProcess
    })

    await main.run()

    expect(path.resolve('firmware.elf')).toBe(path.resolve('firmware.elf'))
    expect(spawnMock).toHaveBeenCalledWith(
      'arm-none-eabi-gdb',
      [path.resolve('firmware.elf')],
      {
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    expect(processMock.stdin.write).toHaveBeenCalledWith(
      'target remote localhost:3333\n'
    )
    expect(processMock.stdin.write).toHaveBeenCalledWith('set pagination off\n')
    expect(processMock.stdin.write).toHaveBeenCalledWith('load\n')
    expect(processMock.stdin.write).toHaveBeenCalledWith(
      'monitor arm semihosting enable\n'
    )
    expect(processMock.stdin.write).toHaveBeenCalledWith(
      'monitor arm semihosting_fileio enable\n'
    )
    expect(processMock.stdin.write).toHaveBeenCalledWith('continue\n')
    expect(processMock.kill).toHaveBeenCalled()
    expect(setFailedMock).not.toHaveBeenCalled()
  })

  it('marks the action as failed when gdb reports a fatal target signal', async () => {
    const processMock = createMockGdbProcess()

    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'timeout':
          return '5'
        case 'gdb_target_host':
          return 'localhost:3333'
        case 'executable':
          return 'firmware.elf'
        case 'wait_for_msg':
          return 'DONE'
        default:
          return ''
      }
    })

    spawnMock.mockImplementation(() => {
      process.nextTick(() => {
        processMock.stdout.emit(
          'data',
          Buffer.from(
            'Program received signal SIGTRAP, Trace/breakpoint trap.\n'
          )
        )
      })

      return processMock as unknown as ChildProcess
    })

    await main.run()

    expect(processMock.kill).toHaveBeenCalled()
    expect(setFailedMock).toHaveBeenCalledWith(
      'Target stopped with a fatal signal: Program received signal SIGTRAP, Trace/breakpoint trap.'
    )
  })
})

describe('getTestResult', () => {
  it.each([
    ['Pass [97] test_standardConfig() [1.0 ms]', 'Pass'],
    ['Fail [96] test_standardConfig() [363.9 ms]', 'Fail'],
    ['Skip [327] test_standardConfig() [135.6 ms]', 'Skip'],
    ['✅ \x1b[32mPass\x1b[0m [97] test_standardConfig()', 'Pass'],
    ['❌ \x1b[31mFail\x1b[0m [96] test_standardConfig()', 'Fail'],
    ['⚠️ \x1b[33mSkip\x1b[0m [327] test_standardConfig()', 'Skip']
  ])('recognizes "%s"', (line, expected) => {
    expect(main.getTestResult(line)).toBe(expected)
  })

  it.each([
    'ordinary log line',
    'Failing to start',
    'Pass test without an index',
    '✅ unrelated message',
    '✅ Pass [97] test without ANSI colors',
    '\x1b[31mFail\x1b[0m [96] test without an icon'
  ])('ignores "%s"', line => {
    expect(main.getTestResult(line)).toBeNull()
  })
})

describe('getGdbFatalError', () => {
  it.each([
    [
      'unknown/unexpected STLINK status code 0x18',
      'GDB/STLINK reported an unexpected status: unknown/unexpected STLINK status code 0x18'
    ],
    [
      'Program received signal SIGTRAP, Trace/breakpoint trap.',
      'Target stopped with a fatal signal: Program received signal SIGTRAP, Trace/breakpoint trap.'
    ],
    [
      'Program received signal SIGSEGV, Segmentation fault.',
      'Target stopped with a fatal signal: Program received signal SIGSEGV, Segmentation fault.'
    ],
    [
      'Remote communication error.  Target disconnected.',
      'GDB remote communication failed: Remote communication error.  Target disconnected.'
    ]
  ])('recognizes "%s"', (line, expected) => {
    expect(main.getGdbFatalError(line)).toBe(expected)
  })

  it.each([
    'FS: The file "test_files/valid_configs/00194.apscfg" is open.',
    'Pass [97] test_standardConfig() [1.0 ms]',
    'Transfer rate: 1024 KB/sec'
  ])('ignores "%s"', line => {
    expect(main.getGdbFatalError(line)).toBeNull()
  })
})
