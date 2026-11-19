'use strict'

const fs = require('fs')
const path = require('path')
const {Readable} = require('stream')
const {promisify} = require('util')
const {test} = require('tap')
const TailFile = require('../index.js')
const getSymbols = require('./get-symbols.js')
const immediate = promisify(setImmediate)

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return {promise, resolve}
}

function bounded(promise) {
  let timer
  return Promise.race([
    promise
  , new Promise((resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('Lifecycle test deadline')) }, 1500)
    })
  ]).finally(() => { clearTimeout(timer) })
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1500
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Lifecycle error state deadline')
    await immediate()
  }
}

function fixture(t, opts = {}, filename) {
  filename = filename || path.join(t.testdir({'active.log': ''}), 'active.log')
  const tail = new TailFile(filename, {
    pollFileIntervalMs: 60000
  , highWaterMark: 4
  , readStreamOpts: {highWaterMark: 1}
  , ...opts
  })
  const symbols = getSymbols(tail)
  const errors = []
  tail.on('error', (error) => { errors.push(error) })
  t.teardown(async () => {
    tail.destroy()
    clearTimeout(tail[symbols.pollTimer])
    await waitFor(() => { return tail.closed })
  })
  return {tail, filename, symbols, errors}
}

async function ready(tail) {
  const flushed = new Promise((resolve) => { tail.once('flush', resolve) })
  await bounded(tail.start())
  await bounded(flushed)
}

function observeFailure(tail) {
  const reported = []
  let flushes = 0
  tail.on('tail_error', (error) => { reported.push(error) })
  tail.on('flush', () => { flushes++ })
  return {
    reported
  , flushes: () => { return flushes }
  }
}

async function rejection(promise) {
  return bounded(promise.then(() => {
    throw new Error('Failed shutdown unexpectedly resolved')
  }, (error) => { return error }))
}

function ordinaryFailure(t, result, actual, code) {
  t.equal(actual.code, code)
  t.equal(result.reported.length, 1, 'one recoverable error is reported')
  t.equal(result.reported[0].code, 'ETAIL')
  t.equal(result.reported[0].meta.actual, actual, 'shutdown preserves the actual failure')
  t.equal(result.flushes(), 0, 'failed draining does not report a successful flush')
}

test('An invalid borrowed descriptor object retains Node validation', async (t) => {
  const {tail, filename, errors} = fixture(t, {
    readStreamOpts: {fd: {fd: 7, read() {}}, autoClose: false}
  })
  await ready(tail)
  const result = observeFailure(tail)
  await fs.promises.appendFile(filename, 'unread')
  const actual = await rejection(tail.quit())
  ordinaryFailure(t, result, actual, 'ERR_INVALID_ARG_TYPE')
  t.same(errors, [], 'source validation does not become a fatal stream error')
})

test('A borrowed FileHandle with custom fs retains Node rejection', async (t) => {
  const filename = path.join(t.testdir({'active.log': ''}), 'active.log')
  const handle = await fs.promises.open(filename, 'r')
  t.teardown(() => { return bounded(handle.close()) })
  const {tail} = fixture(t, {
    readStreamOpts: {fd: handle, autoClose: false, fs}
  }, filename)
  await ready(tail)
  const result = observeFailure(tail)
  await fs.promises.appendFile(filename, 'unread')
  const actual = await rejection(tail.quit())
  ordinaryFailure(t, result, actual, 'ERR_METHOD_NOT_IMPLEMENTED')
  t.equal((await handle.stat()).size, 6, 'the rejected caller handle stays usable')
  await bounded(handle.close())
  t.equal(handle.fd, -1, 'no retained stream reference prevents caller cleanup')
})

test('An invalid custom read method retains Node validation', async (t) => {
  const filename = path.join(t.testdir({'active.log': ''}), 'active.log')
  const fd = fs.openSync(filename, 'r')
  t.teardown(() => { fs.closeSync(fd) })
  const {tail} = fixture(t, {
    readStreamOpts: {fd, autoClose: false, fs: {read: 42}}
  }, filename)
  await ready(tail)
  const result = observeFailure(tail)
  await fs.promises.appendFile(filename, 'unread')
  const actual = await rejection(tail.quit())
  ordinaryFailure(t, result, actual, 'ERR_INVALID_ARG_TYPE')
  t.equal(fs.fstatSync(fd).size, 6, 'the caller descriptor stays open')
})

test('Synchronous source failures retain their original error', async (t) => {
  const {tail, filename, symbols} = fixture(t)
  await ready(tail)
  const handle = tail[symbols.fileHandle]
  const failure = Object.assign(new Error('source failed'), {code: 'ESOURCE'})
  const create = fs.createReadStream
  fs.createReadStream = (...args) => {
    if (args[0] === filename) throw failure
    return create(...args)
  }
  t.teardown(() => { fs.createReadStream = create })
  const result = observeFailure(tail)
  await fs.promises.appendFile(filename, 'unread')
  const actual = await rejection(tail.quit())
  t.equal(actual, failure)
  ordinaryFailure(t, result, actual, 'ESOURCE')
  t.equal(handle.fd, -1, 'the retained handle closes despite construction failure')
})

for (const missing of [false, true]) {
  test(`A failed final remainder rejects quit; missing pathname=${missing}`, async (t) => {
    const {tail, filename, symbols, errors} = fixture(t)
    await ready(tail)
    await fs.promises.appendFile(filename, 'old remainder')
    await fs.promises.rename(filename, `${filename}.1`)
    if (!missing) await fs.promises.writeFile(filename, 'replacement')
    const handle = tail[symbols.fileHandle]
    const read = handle.read.bind(handle)
    const failure = Object.assign(new Error('remainder read failed'), {code: 'EIO'})
    let reads = 0
    handle.read = async (...args) => {
      if (++reads === 2) throw failure
      return read(...args)
    }
    const chunks = []
    tail.on('data', (chunk) => { chunks.push(chunk) })
    const result = observeFailure(tail)
    const actual = await rejection(tail.quit())
    t.equal(actual, failure, 'quit rejects with the actual remainder I/O error')
    t.equal(result.reported.length, 1)
    if (missing) t.equal(result.reported[0], failure, 'notification shape stays intact')
    else {
      t.equal(result.reported[0].message, 'Could not read remaining bytes from old FH')
      t.equal(result.reported[0].meta.code, 'EIO')
    }
    t.equal(Buffer.concat(chunks).toString(), 'old ', 'completed reads are delivered')
    t.equal(result.flushes(), 0, 'a partial failed drain is not a successful flush')
    t.same(errors, [], 'the remainder error notification is not duplicated')
    t.equal(handle.fd, -1)
    t.equal(tail[symbols.fileHandle], null, 'a replacement is not opened after failure')
  })
}

test('A fatal final stat error retains handled error/end ordering', async (t) => {
  const {tail, filename, errors, symbols} = fixture(t)
  await ready(tail)
  tail.resume()
  const handle = tail[symbols.fileHandle]
  const failure = Object.assign(new Error('final stat failed'), {code: 'EACCES'})
  const stat = fs.promises.stat
  fs.promises.stat = async (...args) => {
    if (args[0] === filename) throw failure
    return stat(...args)
  }
  t.teardown(() => { fs.promises.stat = stat })
  const events = []
  tail.on('error', () => { events.push('error') })
  tail.on('end', () => { events.push('end') })
  tail.on('close', () => { events.push('close') })
  const closed = new Promise((resolve) => { tail.once('close', resolve) })
  const result = observeFailure(tail)
  const actual = await rejection(tail.quit())
  await bounded(closed)
  t.equal(actual, failure)
  t.same(errors, [failure])
  t.same(events, ['error', 'end', 'close'])
  t.same(result.reported, [], 'fatal polling does not manufacture a tail_error')
  t.equal(result.flushes(), 0)
  t.equal(handle.fd, -1, 'cleanup completes before close')
})

test('An active paused source failure rejects the waiting graceful quit', async (t) => {
  const {tail, filename, symbols, errors} = fixture(t, {highWaterMark: 1})
  await ready(tail)
  const failure = Object.assign(new Error('resumed active source failed'), {code: 'EIO'})
  const finish = deferred()
  t.teardown(finish.resolve)
  async function* generate() {
    yield Buffer.from('A')
    await finish.promise
    throw failure
  }
  const source = Readable.from(generate(), {objectMode: false, highWaterMark: 1})
  const create = fs.createReadStream
  let constructions = 0
  fs.createReadStream = (...args) => {
    if (args[0] !== filename) return create(...args)
    constructions++
    return source
  }
  t.teardown(() => { fs.createReadStream = create })
  const result = observeFailure(tail)
  await fs.promises.appendFile(filename, 'ABC')
  const pending = tail._pollFileForChanges()
  pending.catch(() => {})
  await waitFor(() => { return tail[symbols.demand] })
  const quitting = rejection(tail.quit())
  const chunks = []
  tail.on('data', (chunk) => { chunks.push(chunk) })
  finish.resolve()
  const actual = await quitting
  await bounded(pending)
  t.equal(actual, failure)
  ordinaryFailure(t, result, actual, 'EIO')
  t.equal(constructions, 1, 'shutdown does not overlap or retry the failed active source')
  t.equal(Buffer.concat(chunks).toString(), 'A')
  t.same(errors, [], 'the resumed failure follows the recoverable error path')
  t.equal(source.closed, true)
})

test('A fatal active poll settles a waiting quit without a shutdown cycle', async (t) => {
  const {tail, filename, symbols, errors} = fixture(t)
  await ready(tail)
  tail.resume()
  const handle = tail[symbols.fileHandle]
  const failure = Object.assign(new Error('active stat failed'), {code: 'EACCES'})
  const entered = deferred()
  const finish = deferred()
  const stat = fs.promises.stat
  fs.promises.stat = async (...args) => {
    if (args[0] !== filename) return stat(...args)
    entered.resolve()
    await finish.promise
    throw failure
  }
  t.teardown(() => {
    fs.promises.stat = stat
    finish.resolve()
  })
  const events = []
  tail.on('error', () => { events.push('error') })
  tail.on('end', () => { events.push('end') })
  tail.on('close', () => { events.push('close') })
  const closed = new Promise((resolve) => { tail.once('close', resolve) })
  const result = observeFailure(tail)
  const pending = tail._pollFileForChanges()
  pending.catch(() => {})
  await bounded(entered.promise)
  const quitting = rejection(tail.quit())
  finish.resolve()
  const actual = await quitting
  await bounded(pending)
  await bounded(closed)
  t.equal(actual, failure, 'the active polling failure rejects the pending quit')
  t.same(errors, [failure])
  t.same(events, ['error', 'end', 'close'])
  t.same(result.reported, [])
  t.equal(result.flushes(), 0)
  t.equal(handle.fd, -1, 'both operations settle after resource cleanup')
})

test('A later retry listener exception is observed and releases resources', async (t) => {
  const {tail, filename, symbols, errors} = fixture(t, {
    pollFileIntervalMs: 15
  , pollFailureRetryMs: 15
  })
  await ready(tail)
  const handle = tail[symbols.fileHandle]
  const failure = Object.assign(new Error('retry listener failed'), {code: 'ELISTENER'})
  const events = []
  const result = observeFailure(tail)
  let retries = 0
  tail.on('error', () => { events.push('error') })
  tail.on('end', () => { events.push('end') })
  tail.on('close', () => { events.push('close') })
  tail.once('retry', () => {
    retries++
    throw failure
  })
  const emitted = new Promise((resolve) => { tail.once('error', resolve) })
  const closed = new Promise((resolve) => { tail.once('close', resolve) })
  await fs.promises.rename(filename, `${filename}.1`)
  t.equal(await bounded(emitted), failure, 'the timer observes the listener exception')
  await bounded(closed)
  t.equal(retries, 1, 'the failure came from a scheduled retry notification')
  t.same(errors, [failure], 'the original exception is emitted once')
  t.same(events, ['error', 'close'], 'abortive timer failure does not claim graceful end')
  t.same(result.reported, [], 'the listener exception is not an ordinary read error')
  t.equal(result.flushes(), 0)
  t.equal(handle.fd, -1)
  t.equal(tail[symbols.pollTimer], null, 'failed timer polling is stopped')
})
