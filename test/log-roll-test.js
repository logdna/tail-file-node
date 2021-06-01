'use strict'

const fs = require('fs')
const path = require('path')
const readline = require('readline')
const {test} = require('tap')
const getSymbols = require('./get-symbols.js')
const TailFile = require('../index.js')

const LOG_FILE_NAME = 'somelog.txt'
const ITERATIONS = 10000

test('Continous logging with log rolling at the same time', (t) => {
  t.plan(13)
  const testDir = t.testdir({
    [LOG_FILE_NAME]: ''
  })
  const LOG_FILE_PATH = path.join(testDir, LOG_FILE_NAME)

  const tail = new TailFile(LOG_FILE_PATH, {
    pollFileIntervalMs: 200 // Make this shorter since we're rolling quickly
  })
    .on('error', (err) => {
      t.fail(err)
    })
    .on('end', () => {
      t.pass('Done')
    })

  const linesplitter = readline.createInterface({
    input: tail
  })

  let counter = 0
  linesplitter.on('line', (line) => {
    if (++counter % 1000 === 0) {
      t.pass(`Received ${counter} lines`)
    }
    // Ensure order.  Only do a fail to minimize .plan() assertions
    const expected = `This is line ${counter}`
    if (line !== expected) {
      t.fail('Line is out of order!', {
        expected
      , got: line
      })
    }
    if (counter === ITERATIONS) {
      t.pass('All lines received')
    }
  })

  t.test('Start logging and rolling', async (tt) => {
    await tail.start()

    for (let i = 1; i <= ITERATIONS; i++) {
      if (i === ITERATIONS / 2) {
        // Roll halfway through
        await fs.promises.rename(LOG_FILE_PATH, `${LOG_FILE_PATH}.${i}`)
        await fs.promises.writeFile(LOG_FILE_PATH, '', 'utf8')
        tt.pass(`Rolled log halfway through at #${i}`)
      }
      await fs.promises.appendFile(LOG_FILE_PATH, `This is line ${i}\n`)
    }
    await tail.quit()
  })
})

test('Data not flowing pauses polling, but still tolerates 1 log roll', (t) => {
  t.plan(4) // 3 sub-tests and 1 parent assertion
  const testDir = t.testdir({
    [LOG_FILE_NAME]: ''
  })
  const LOG_FILE_PATH = path.join(testDir, LOG_FILE_NAME)

  const tail = new TailFile(LOG_FILE_PATH, {
    pollFileIntervalMs: 200 // Make this shorter since we're rolling quickly
  })
    .on('error', (err) => {
      t.fail(err)
    })
    .on('end', () => {
      t.pass('Done')
    })

  t.test('Start logging and rolling, but data is not being consumed yet', async (tt) => {
    await tail.start()

    for (let i = 1; i <= ITERATIONS; i++) {
      if (i === ITERATIONS / 2) {
        // Roll halfway through
        await fs.promises.rename(LOG_FILE_PATH, `${LOG_FILE_PATH}.${i}`)
        await fs.promises.writeFile(LOG_FILE_PATH, '', 'utf8')
        tt.pass(`Rolled log halfway through at #${i}`)
      }
      await fs.promises.appendFile(LOG_FILE_PATH, `This is line ${i}\n`)
    }
  })

  t.test('Check to see that backpressure is on and polling is stopped', async (tt) => {
    const symbols = getSymbols(tail)
    tt.ok(tail[symbols.stream], 'Backpressure is on because "stream" has been stored')
    tt.same(this[symbols.pollTimer], null, 'Poll timer has been set to null')
  })

  t.test('Start data "flowing" by adding a listener and consuming', (tt) => {
    const linesplitter = readline.createInterface({
      input: tail
    })

    let counter = 0
    linesplitter.on('line', (line) => {
      if (++counter % 1000 === 0) {
        tt.pass(`Received ${counter} lines`)
      }
      // Ensure order.  Only do a fail to minimize .plan() assertions
      if (line !== `This is line ${counter}`) {
        tt.fail('Line is out of order!', {
          expected: counter
        , got: line
        })
      }
      if (counter === ITERATIONS) {
        tt.pass('All lines received')
        tail.quit()
        tt.end()
      }
    })
  })
})
