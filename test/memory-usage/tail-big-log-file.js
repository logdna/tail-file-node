'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const readline = require('readline')
const {spawn} = require('child_process')
const {test} = require('tap')
const TailFile = require('../../index.js')

const ALL_DONE_AFTER_TIME = 5000 // Close tail after 5 seconds of inactivity
const shellCmd = path.join(__dirname, 'populate-big-log.sh')

test('Memory consumption', async (t) => {
  const LOG_FILE_NAME = 'big-log-file.log'
  const testDir = os.tmpdir()
  const LOG_FILE_PATH = path.join(testDir, LOG_FILE_NAME)

  t.test('Create a stub for the large log file', async (t) => {
    await fs.promises.writeFile(LOG_FILE_PATH, '', 'utf8')
  })

  t.test('Report memory consumptions when lots of large lines are consumed', (t) => {
    const tail = new TailFile(LOG_FILE_PATH)
      .on('error', (err) => {
        t.fail(err)
      })

    t.teardown(async () => {
      await tail.quit()
    })

    const lineSplitter = readline.createInterface({
      input: tail
    })

    let counter = 0
    let timer = null
    // Resident Set Size - occupied memory including heap, segment and stack
    let rssMin = Infinity
    let rssMax = 0

    lineSplitter.on('line', (line) => {
      clearTimeout(timer)
      if (++counter % 10000 === 0) {
        const usage = process.memoryUsage()
        if (usage.rss < rssMin) rssMin = usage.rss
        if (usage.rss > rssMax) rssMax = usage.rss
        t.pass(`Memory usage at ${counter} lines: ${JSON.stringify(usage)}`)
      }
      timer = setTimeout(() => {
        t.pass('No more lines, test ending')
        lineSplitter.removeAllListeners()
        t.pass(`Min Resident Set Size: ${Math.round(rssMin / 1024 / 1024)} MB`)
        t.pass(`Max Resident Set Size: ${Math.round(rssMax / 1024 / 1024)} MB`)
        t.end()
      }, ALL_DONE_AFTER_TIME)
    })

    tail.start().catch((err) => {
      console.error('TailFile got an error on start', err)
    })

    // For this test, we want the tail to be listening when the log gets flooded
    spawn(shellCmd, [LOG_FILE_PATH], {
      cwd: testDir
    })
  })

  test('Cleanup (remove) the log file', async (t) => {
    await fs.promises.unlink(LOG_FILE_PATH)
  })
})
