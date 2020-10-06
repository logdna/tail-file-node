'use strict'

const fs = require('fs')
const path = require('path')
const readline = require('readline')
const {spawn} = require('child_process')
const {test} = require('tap')
const TailFile = require('../../index.js')

const ALL_DONE_AFTER_TIME = 5000 // Close tail after 5 seconds of inactivity
const LOG_FILE_PATH = path.join(__dirname, 'log-to-tail.log')
const shellCmd = path.join(__dirname, 'populate-log.sh')

test('Create the log file', async (t) => {
  await fs.promises.writeFile(LOG_FILE_PATH, '', 'utf8')
})

test('Report memory consumptions when lots of large lines are consumed', (t) => {
  const tail = new TailFile(LOG_FILE_PATH)
    .on('error', (err) => {
      t.fail(err)
    })

  t.teardown(async () => {
    await tail.quit()
  })

  const linesplitter = readline.createInterface({
    input: tail
  })

  let counter = 0
  let timer = null
  // Resident Set Size - occupied memory including heap, segment and stack
  let rssMin = Infinity
  let rssMax = 0

  linesplitter.on('line', (line) => {
    clearTimeout(timer)
    if (++counter % 10000 === 0) {
      const usage = process.memoryUsage()
      if (usage.rss < rssMin) rssMin = usage.rss
      if (usage.rss > rssMax) rssMax = usage.rss
      t.pass(`Memory usage at ${counter} lines: ${JSON.stringify(usage)}`)
    }
    timer = setTimeout(() => {
      t.pass('No more lines, test ending')
      linesplitter.removeAllListeners()
      t.pass(`Min Resident Set Size: ${Math.round(rssMin / 1024 / 1024)} MB`)
      t.pass(`Max Resident Set Size: ${Math.round(rssMax / 1024 / 1024)} MB`)
      t.end()
    }, ALL_DONE_AFTER_TIME)
  })

  tail.start().catch((err) => {
    console.error('TailFile got an error on start', err)
  })

  spawn(shellCmd, {
    cwd: __dirname
  })
})

test('Cleanup (remove) the log file', async (t) => {
  await fs.promises.unlink(LOG_FILE_PATH)
})
