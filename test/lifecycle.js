'use strict'

const path = require('path')
const {spawn} = require('child_process')
const {test} = require('tap')

function runProbe(t, name) {
  const filename = path.join(t.testdir({'active.log': ''}), 'active.log')
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(__dirname, 'fixtures/lifecycle-probe.cjs')
    , name
    , filename
    ], {stdio: ['ignore', 'pipe', 'pipe']})
    let output = ''
    let diagnostic = ''
    let timedOut = false
    const deadline = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, 6000)
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { diagnostic += chunk })
    child.once('error', (error) => {
      clearTimeout(deadline)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(deadline)
      if (timedOut || code !== 0) {
        reject(new Error(`Probe ${name} failed (${code || signal}): ${diagnostic}`))
        return
      }
      try {
        const result = JSON.parse(output)
        if (result.probe !== name) throw new Error('Unexpected probe response')
        resolve(result)
      } catch (error) {
        reject(error)
      }
    })
  })
}

test('Resumed ordinary read failures use tail_error', async (t) => {
  const result = await runProbe(t, 'resumed-error')
  t.equal(result.tailErrors, 1, 'recoverable read error is reported')
  t.same(result.unhandled, [], 'resumption does not reject without a handler')
})

for (const name of ['idle-destroy', 'ordinary-destroy', 'idle-destroy-no-close']) {
  test(`Cancellation releases owned resources: ${name}`, async (t) => {
    const result = await runProbe(t, name)
    t.equal(result.closed, true, 'destruction completes')
    t.equal(result.handlesClosed, true, 'owned handles close before completion')
    t.equal(result.sourcesClosed, true, 'owned sources close before completion')
    t.equal(result.pollsAfterClose, 0, 'polling does not continue after destruction')
  })
}

test('Final polling cannot overlap an ordinary paused read', async (t) => {
  const result = await runProbe(t, 'ordinary-overlap')
  t.equal(result.overlappingRead, false, 'final read waits for the saved source')
  t.equal(result.settled, true, 'graceful quit completes after consumption')
  t.equal(result.output, 'ABC', 'every byte arrives exactly once')
})

test('A queued earlier flush cannot complete the final read', async (t) => {
  const result = await runProbe(t, 'stale-flush')
  t.equal(result.settledBeforeFinalStat, false, 'quit waits for its own final poll')
  t.equal(result.settled, true, 'quit completes after the final read')
  t.equal(result.output, 'FINAL', 'final bytes arrive before graceful completion')
})

test('A missing final pathname does not leave quit pending', async (t) => {
  const result = await runProbe(t, 'missing-path')
  t.equal(result.settled, true, 'the completed final poll settles shutdown')
  t.equal(result.outcome, 'resolved', 'missing path alone is not a shutdown failure')
  t.equal(result.output, 'UNREAD', 'accessible old bytes are drained first')
})

for (const name of ['ordinary-cancel', 'rotation-cancel', 'rotation-cancel-no-close']) {
  test(`Cancellation settles an outstanding graceful quit: ${name}`, async (t) => {
    const result = await runProbe(t, name)
    t.equal(result.settled, true, 'shutdown does not retain a flush waiter forever')
    t.equal(result.outcome, 'rejected', 'cancellation does not claim graceful completion')
    t.equal(result.code, 'ABORT_ERR', 'plain destroy interrupts quit with AbortError')
  })
}

test('Supplied cancellation error is preserved by the interrupted quit', async (t) => {
  const result = await runProbe(t, 'rotation-cancel-error')
  t.equal(result.settled, true)
  t.equal(result.outcome, 'rejected')
  t.equal(result.code, 'ESYNTHETIC')
  t.equal(result.sameError, true, 'quit rejects with the supplied error object')
})

test('Legacy error quit retains event order in established flowing mode', async (t) => {
  const result = await runProbe(t, 'legacy-error-quit')
  t.equal(result.settled, true)
  t.same(result.events, ['error', 'end', 'close'])
  t.same(result.unhandled, [])
})

test('Startup remains usable before initial bytes are consumed', async (t) => {
  const result = await runProbe(t, 'startup-before-consumption')
  t.equal(result.output, 'initial bytes €😀')
  t.equal(result.settled, true)
})

test('Cancellation closes a late opened handle before reporting close', async (t) => {
  const result = await runProbe(t, 'pending-open-cancel')
  t.equal(result.closedBeforeOpenReturns, false, 'close waits for pending open')
  t.equal(result.startupSettled, true, 'startup does not stay pending')
  t.equal(result.handlesClosedAtClose, true, 'close follows handle cleanup')
  t.equal(result.handlesClosed, true, 'late handle is not retained')
})
