'use strict'

// Isolate deliberately broken lifecycle paths: snapshots precede manual cleanup,
// and the child always exits so a leaked descriptor or pending quit cannot hang tap.
/* eslint-disable no-process-exit */
const fs = require('fs')
const path = require('path')
const {Readable} = require('stream')
const TailFile = require('../../index.js')

const probe = process.argv[2]
const filename = path.resolve(process.argv[3])
const handles = []
const sources = []
const tails = []
const unhandled = []
const originalOpen = fs.promises.open
const originalStat = fs.promises.stat
const originalCreate = fs.createReadStream
let statCalls = 0
let statOverride
let sourceFactory

process.on('unhandledRejection', (error) => {
  unhandled.push(error.message)
})

const hardDeadline = setTimeout(() => {
  process.stderr.write(`Lifecycle probe exceeded its deadline: ${probe}\n`)
  process.exit(2)
}, 4000)

fs.promises.open = async (...args) => {
  const handle = await originalOpen(...args)
  handles.push(handle)
  return handle
}

fs.promises.stat = async (...args) => {
  if (path.resolve(args[0]) === filename) {
    statCalls++
    if (statOverride) return statOverride(...args)
  }
  return originalStat(...args)
}

fs.createReadStream = (...args) => {
  const source = sourceFactory
    ? sourceFactory(...args)
    : originalCreate(...args)
  sources.push(source)
  return source
}

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return {promise, resolve}
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function immediate() {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Probe precondition failed: ${probe}`)
    await immediate()
  }
}

function settlement(promise) {
  const state = {settled: false}
  Promise.resolve(promise).then(() => {
    state.settled = true
    state.outcome = 'resolved'
  }, (error) => {
    state.settled = true
    state.outcome = 'rejected'
    state.code = error && error.code
  })
  return state
}

async function observe(state) {
  const deadline = Date.now() + 500
  while (!state.settled && Date.now() < deadline) await immediate()
  return {...state}
}

async function makeTail(opts, quiet = true, contents = '') {
  await fs.promises.writeFile(filename, contents)
  const tail = new TailFile(filename, {
    highWaterMark: 1
  , readStreamOpts: {highWaterMark: 1}
  , pollFileIntervalMs: 60000
  , ...opts
  })
  const record = {tail, errors: [], tailErrors: [], flushes: 0}
  tail.on('error', (error) => { record.errors.push(error.code || error.message) })
  tail.on('tail_error', (error) => {
    record.tailErrors.push(error.code || error.message)
  })
  tail.on('flush', () => { record.flushes++ })
  tails.push(record)
  await tail.start()
  // Ordinary and cancellation probes must not accidentally consume startup's
  // queued flush. The stale-flush probe deliberately skips this wait.
  if (quiet) await waitFor(() => { return record.flushes > 0 })
  return record
}

function poll(tail) {
  const state = settlement(tail._pollFileForChanges())
  return state
}

function resources() {
  return {
    handlesClosed: handles.every((handle) => { return handle.fd === -1 })
  , sourcesClosed: sources.every((source) => { return source.closed })
  }
}

function controlledSource(next) {
  const source = new Readable({read() {}})
  source.iterator = () => {
    return {
      [Symbol.asyncIterator]() { return this }
    , next
    , async return() { return {done: true} }
    }
  }
  return source
}

async function ordinaryPause(record, bytes = Buffer.alloc(32, 65)) {
  await fs.promises.appendFile(filename, bytes)
  poll(record.tail)
  await waitFor(() => { return record.tail.readableLength >= 1 && sources.length > 0 })
}

async function rotationPause(record) {
  await fs.promises.appendFile(filename, Buffer.alloc(32, 65))
  await fs.promises.rename(filename, `${filename}.1`)
  await fs.promises.writeFile(filename, 'new')
  poll(record.tail)
  await waitFor(() => { return record.tail.readableLength >= 1 })
}

async function destroyResources(ordinary, emitClose) {
  const record = await makeTail({pollFileIntervalMs: 20, emitClose})
  if (ordinary) await ordinaryPause(record)
  record.tail.destroy()
  await waitFor(() => { return record.tail.closed })
  const atClose = resources()
  const before = statCalls
  await delay(60)
  return {...atClose, pollsAfterClose: statCalls - before, closed: record.tail.closed}
}

async function resumedError() {
  let position = 0
  sourceFactory = () => {
    return controlledSource(async () => {
      if (position++ === 0) return {value: Buffer.from('A'), done: false}
      if (position === 2) {
        throw Object.assign(new Error('synthetic resumed read failure'), {code: 'EIO'})
      }
      return {done: true}
    })
  }
  const record = await makeTail()
  await ordinaryPause(record, Buffer.from('AB'))
  record.tail.resume()
  await waitFor(() => { return record.tailErrors.length > 0 || unhandled.length > 0 })
  return {tailErrors: record.tailErrors.length, unhandled: [...unhandled]}
}

async function ordinaryOverlap() {
  const oldB = deferred()
  const newB = deferred()
  let overlap = false
  sourceFactory = (file, opts) => {
    const id = sources.length
    let position = opts.start
    return controlledSource(async () => {
      if (position >= 3) return {done: true}
      if (id === 0 && position === 1) oldB.resolve()
      if (id === 0 && position === 2 && overlap) await newB.promise
      if (id === 1 && position === 1) {
        await oldB.promise
        newB.resolve()
      }
      return {value: Buffer.from('ABC'[position++]), done: false}
    })
  }
  const record = await makeTail()
  await ordinaryPause(record, Buffer.from('ABC'))
  const stats = await originalStat(filename)
  const big_int_stats = await originalStat(filename, {bigint: true})
  // Remove filesystem scheduling luck from the final-poll interleaving.
  statOverride = async (file, options) => {
    if (options && options.bigint) return big_int_stats
    return stats
  }
  const quitting = settlement(record.tail.quit())
  await immediate()
  overlap = sources.length > 1
  const chunks = []
  record.tail.on('data', (chunk) => { chunks.push(chunk) })
  const result = await observe(quitting)
  await immediate()
  return {...result, overlappingRead: overlap, output: Buffer.concat(chunks).toString()}
}

async function staleFlush() {
  const record = await makeTail({}, false)
  const chunks = []
  record.tail.on('data', (chunk) => { chunks.push(chunk) })
  fs.appendFileSync(filename, 'FINAL')
  const entered = deferred()
  const release = deferred()
  statOverride = async (...args) => {
    entered.resolve()
    await release.promise
    return originalStat(...args)
  }
  const originalPoll = record.tail._pollFileForChanges.bind(record.tail)
  const polls = []
  record.tail._pollFileForChanges = (...args) => {
    const pending = originalPoll(...args)
    polls.push(settlement(pending))
    return pending
  }
  const quitting = settlement(record.tail.quit())
  await entered.promise
  await immediate()
  const settledBeforeFinalStat = quitting.settled
  statOverride = null
  release.resolve()
  const result = await observe(quitting)
  for (const pending of polls) await observe(pending)
  await immediate()
  return {...result, settledBeforeFinalStat, output: Buffer.concat(chunks).toString()}
}

async function missingPath() {
  const record = await makeTail()
  const chunks = []
  record.tail.on('data', (chunk) => { chunks.push(chunk) })
  await fs.promises.appendFile(filename, 'UNREAD')
  record.tail.resume()
  await fs.promises.rename(filename, `${filename}.1`)
  const result = await observe(settlement(record.tail.quit()))
  return {...result, output: Buffer.concat(chunks).toString()}
}

async function cancelQuit(rotation, emitClose, withError) {
  const record = await makeTail({emitClose})
  if (rotation) await rotationPause(record)
  else await ordinaryPause(record)
  const error = withError
    ? Object.assign(new Error('supplied cancellation'), {code: 'ESYNTHETIC'})
    : undefined
  let sameError = false
  const promise = record.tail.quit()
  promise.catch((actual) => { sameError = actual === error })
  const quitting = settlement(promise)
  record.tail.destroy(error)
  const result = await observe(quitting)
  return {...result, sameError}
}

async function legacyErrorQuit() {
  const record = await makeTail()
  const events = []
  for (const event of ['error', 'end', 'close']) {
    record.tail.on(event, () => { events.push(event) })
  }
  // Establish flowing mode first. Calling resume() and quit(error) in the same
  // turn can produce a second, synthetic end on the baseline; that separate
  // inherited edge case is not the compatibility contract asserted here.
  await new Promise((resolve) => {
    record.tail.once('resume', resolve)
    record.tail.resume()
  })
  const quitting = settlement(record.tail.quit(new Error('legacy quit failure')))
  await observe(quitting)
  await waitFor(() => { return record.tail.closed })
  return {...quitting, events, unhandled: [...unhandled]}
}

async function startupBeforeConsumption() {
  const expected = 'initial bytes €😀'
  const record = await makeTail({startPos: 0}, false, expected)
  await waitFor(() => { return record.tail.readableLength > 0 })
  const chunks = []
  record.tail.on('data', (chunk) => { chunks.push(chunk) })
  await waitFor(() => { return Buffer.concat(chunks).toString() === expected })
  const quitting = await observe(settlement(record.tail.quit()))
  return {...quitting, output: Buffer.concat(chunks).toString()}
}

async function pendingOpenCancellation() {
  await fs.promises.writeFile(filename, '')
  const entered = deferred()
  const release = deferred()
  fs.promises.open = async (...args) => {
    const handle = await originalOpen(...args)
    handles.push(handle)
    entered.resolve()
    await release.promise
    return handle
  }
  const tail = new TailFile(filename, {pollFileIntervalMs: 60000})
  tails.push({tail})
  tail.on('error', () => {})
  let handlesClosedAtClose
  tail.on('close', () => { handlesClosedAtClose = resources().handlesClosed })
  const starting = settlement(tail.start())
  await entered.promise
  tail.destroy()
  await immediate()
  const closedBeforeOpenReturns = tail.closed
  release.resolve()
  const startup = await observe(starting)
  await waitFor(() => { return tail.closed })
  return {
    startupSettled: startup.settled
  , closedBeforeOpenReturns
  , handlesClosedAtClose
  , handlesClosed: resources().handlesClosed
  }
}

async function cleanup() {
  // This is test disposal, never part of the measured result. Baseline defects
  // may leave promises/streams pending; the child exit is the final safety net.
  fs.promises.open = originalOpen
  fs.promises.stat = originalStat
  fs.createReadStream = originalCreate
  for (const {tail} of tails) tail.destroy()
  for (const source of sources) source.destroy()
  await Promise.race([
    Promise.all(handles.map((handle) => { return handle.close().catch(() => {}) }))
  , delay(150)
  ])
}

async function main() {
  let result
  switch (probe) {
    case 'resumed-error': result = await resumedError(); break
    case 'idle-destroy': result = await destroyResources(false, true); break
    case 'ordinary-destroy': result = await destroyResources(true, true); break
    case 'idle-destroy-no-close': result = await destroyResources(false, false); break
    case 'ordinary-overlap': result = await ordinaryOverlap(); break
    case 'stale-flush': result = await staleFlush(); break
    case 'missing-path': result = await missingPath(); break
    case 'ordinary-cancel': result = await cancelQuit(false, true); break
    case 'rotation-cancel': result = await cancelQuit(true, true); break
    case 'rotation-cancel-no-close': result = await cancelQuit(true, false); break
    case 'rotation-cancel-error': result = await cancelQuit(true, true, true); break
    case 'legacy-error-quit': result = await legacyErrorQuit(); break
    case 'startup-before-consumption': result = await startupBeforeConsumption(); break
    case 'pending-open-cancel': result = await pendingOpenCancellation(); break
    default: throw new Error(`Unknown lifecycle probe: ${probe}`)
  }
  await cleanup()
  clearTimeout(hardDeadline)
  process.stdout.write(`${JSON.stringify({probe, ...result})}\n`, () => { process.exit(0) })
}

main().catch(async (error) => {
  await cleanup()
  process.stderr.write(`${error.stack}\n`)
  process.exit(1)
})
