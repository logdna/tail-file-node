'use strict'

const fs = require('fs')
const path = require('path')
const {promisify} = require('util')
const {test} = require('tap')
const TailFile = require('../index.js')
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
      timer = setTimeout(() => { reject(new Error('Cancellation deadline')) }, 2000)
    })
  ]).finally(() => { clearTimeout(timer) })
}

function settlement(promise) {
  const result = {done: false}
  promise.then(() => {
    result.done = true
    result.outcome = 'resolved'
  }, (error) => {
    result.done = true
    result.outcome = 'rejected'
    result.error = error
  })
  return result
}

async function observe(predicate) {
  const deadline = Date.now() + 1200
  while (!predicate() && Date.now() < deadline) await immediate()
  await immediate() // Observe scheduled error/close delivery as well as closed state.
}

async function exercise(t, opts) {
  const {
    outcome, innerClose, outerClose, suppliedError, borrowedKind, startup, backpressure
  } = opts
  const contents = startup ? 'initial bytes' : ''
  const filename = path.join(t.testdir({'active.log': contents}), 'active.log')
  const entered = deferred()
  const release = deferred()
  const handles = []
  const sources = []
  const open = fs.promises.open
  const create = fs.createReadStream
  const read = fs.read
  const cancellation = suppliedError ? new Error('Supplied cancellation') : undefined
  const readError = Object.assign(new Error('Late read failure'), {code: 'EIO'})
  let borrowed
  let borrowedClosed = false
  let sourceCloseEvents = 0
  if (borrowedKind === 'number') borrowed = fs.openSync(filename, 'r')
  if (borrowedKind === 'FileHandle') borrowed = await open(filename, 'r')

  fs.promises.open = async (...args) => {
    const handle = await open(...args)
    if (args[0] === filename) handles.push(handle)
    return handle
  }
  fs.createReadStream = (...args) => {
    const source = create(...args)
    sources.push(source)
    source.on('close', () => { sourceCloseEvents++ })
    // Deliberately no private error observer: cancellation must not produce an
    // unhandled error when its iterator listeners detach.
    return source
  }

  let actualRead
  let reads = 0
  const implementation = {
    open: fs.open.bind(fs)
  , close: fs.close.bind(fs)
  , read(fd, buffer, offset, length, position, callback) {
      // A real truncation produces a real EOF after the pathname poll succeeded.
      if (outcome === 'eof') fs.truncateSync(filename, 0)
      read(fd, buffer, offset, length, position, (error, bytesRead, result) => {
        if (backpressure && reads++ === 0) {
          callback(error, bytesRead, result)
          return
        }
        actualRead = {error, bytesRead}
        entered.resolve()
        release.promise.then(() => {
          if (outcome === 'error') callback(readError, 0, result)
          else callback(error, bytesRead, result)
        })
      })
    }
  }
  const readStreamOpts = {highWaterMark: 1, emitClose: innerClose}
  if (borrowedKind === 'FileHandle') {
    const borrowedFd = borrowed.fd
    fs.read = (fd, ...args) => {
      if (fd === borrowedFd) return implementation.read(fd, ...args)
      return read(fd, ...args)
    }
  } else {
    readStreamOpts.fs = implementation
  }
  if (borrowedKind) {
    readStreamOpts.fd = borrowed
    readStreamOpts.autoClose = false
  }

  const tail = new TailFile(filename, {
    startPos: startup ? 0 : null
  , pollFileIntervalMs: 60000
  , highWaterMark: 1
  , emitClose: outerClose
  , readStreamOpts
  })
  if (backpressure) tail.on('readable', () => {})
  const errors = []
  const late = []
  const events = {cancelled: false}
  let closeEvents = 0
  let cleanedAtClose = false
  tail.on('error', (error) => { errors.push(error) })
  for (const event of ['data', 'flush', 'tail_error']) {
    tail.on(event, () => { if (events.cancelled) late.push(event) })
  }
  tail.on('close', () => {
    closeEvents++
    cleanedAtClose = handles.every((handle) => { return handle.fd === -1 })
      && sources.every((source) => { return source.closed })
  })
  t.teardown(async () => {
    // Disposal is deliberately separate from the observations below, including
    // when the broken baseline leaves its poll and quit promises pending.
    release.resolve()
    tail.destroy()
    fs.promises.open = open
    fs.createReadStream = create
    fs.read = read
    for (const source of sources) source.destroy()
    await bounded(Promise.all(handles.map((handle) => {
      return handle.close().catch(() => {})
    })))
    if (borrowedKind && !borrowedClosed) {
      if (borrowedKind === 'number') fs.closeSync(borrowed)
      else await bounded(borrowed.close())
    }
  })

  let starting
  let polling
  if (startup) {
    starting = settlement(tail.start())
  } else {
    const flushed = new Promise((resolve) => { tail.once('flush', resolve) })
    await bounded(tail.start())
    await bounded(flushed)
    await fs.promises.appendFile(filename, 'appended bytes')
    polling = settlement(tail._pollFileForChanges())
  }
  await bounded(entered.promise)
  if (borrowedKind) {
    const fd = borrowedKind === 'number' ? borrowed : borrowed.fd
    t.equal(sources[0].fd, fd, 'the source reads the caller descriptor')
  } else {
    t.equal(sources[0].path, filename, 'the source reads the requested file')
  }
  t.notOk(actualRead.error, 'the actual filesystem read succeeds')
  if (outcome === 'eof') t.equal(actualRead.bytesRead, 0, 'actual EOF is pending')
  else t.ok(actualRead.bytesRead > 0, 'actual bytes are held before their callback')
  if (backpressure) t.ok(tail.readableLength > 0, 'outer read is paused by backpressure')
  if (startup) t.equal(starting.done, false, 'startup waits for its initial read')
  const quitting = settlement(tail.quit())
  await immediate() // Let graceful quit wait on the active operation first.
  events.cancelled = true
  t.equal(tail.destroy(cancellation), tail, 'destroy remains synchronous and chainable')
  await immediate()
  t.equal(tail.closed, false, 'cleanup waits for the pending native read callback')
  t.equal(sources[0].closed, false, 'source cleanup also waits for that callback')
  t.ok(handles.every((handle) => { return handle.fd >= 0 }), 'handles valid during I/O')
  t.equal(quitting.done, false, 'quit does not settle before resource cleanup')
  release.resolve()
  await observe(() => {
    return tail.closed && quitting.done && sources[0].closed
      && (!polling || polling.done) && (!starting || starting.done)
  })
  t.equal(sources[0].closed, true, 'private source cleanup completes')
  t.equal(sourceCloseEvents, 1, 'private close is emitted despite the supplied option')
  t.equal(tail.closed, true, 'tail cleanup completes without a public close dependency')
  t.ok(handles.every((handle) => { return handle.fd === -1 }), 'owned handles released')
  t.equal(quitting.outcome, 'rejected', 'cancelled graceful quit rejects')
  if (suppliedError) t.equal(quitting.error, cancellation, 'same cancellation error')
  else t.match(quitting.error, {name: 'AbortError', code: 'ABORT_ERR'})
  if (polling) t.equal(polling.done, true, 'ordinary polling unwinds')
  if (starting) {
    t.equal(starting.outcome, 'rejected', 'pending startup rejects on cancellation')
    if (suppliedError) t.equal(starting.error, cancellation)
    else t.match(starting.error, {name: 'AbortError', code: 'ABORT_ERR'})
  }
  t.equal(closeEvents, outerClose ? 1 : 0, 'outer close option is respected')
  if (outerClose) t.equal(cleanedAtClose, true, 'public close follows resource cleanup')
  t.same(late, [], 'no data, successful flush or tail error after cancellation')
  t.same(errors, suppliedError ? [cancellation] : [], 'selected outer error policy')

  if (borrowedKind) {
    const stats = borrowedKind === 'number'
      ? fs.fstatSync(borrowed)
      : await bounded(borrowed.stat())
    t.equal(stats.size, Buffer.byteLength('appended bytes'), 'borrowed fd stays usable')
    if (borrowedKind === 'number') fs.closeSync(borrowed)
    else {
      t.equal(borrowed.listenerCount('close'), 0, 'no retained FileHandle reference')
      await bounded(borrowed.close())
    }
    borrowedClosed = true
  }
}

for (const outcome of ['success', 'eof', 'error']) {
  for (const innerClose of [true, false]) {
    for (const outerClose of [true, false]) {
      for (const suppliedError of [false, true]) {
        const name = `Native ${outcome}; in=${innerClose}, out=${outerClose}, err=${suppliedError}`
        test(name, (t) => {
          return exercise(t, {outcome, innerClose, outerClose, suppliedError})
        })
      }
    }
  }
}

for (const borrowedKind of ['number', 'FileHandle']) {
  for (const suppliedError of [false, true]) {
    test(`Pending borrowed ${borrowedKind}; error=${suppliedError}`, (t) => {
      return exercise(t, {
        outcome: 'success'
      , innerClose: false
      , outerClose: false
      , borrowedKind
      , suppliedError
      })
    })
  }
}

for (const suppliedError of [false, true]) {
  test(`Pending native startup; error=${suppliedError}`, (t) => {
    return exercise(t, {
      outcome: 'success'
    , innerClose: false
    , outerClose: suppliedError
    , suppliedError
    , startup: true
    })
  })
}

for (const outcome of ['success', 'error']) {
  for (const outerClose of [false, true]) {
    const suppliedError = outcome === 'success' && outerClose
    const name = `Pending native ${outcome} prefetch; close=${outerClose}, err=${suppliedError}`
    test(name, (t) => {
      return exercise(t, {
        outcome
      , innerClose: false
      , outerClose
      , suppliedError
      , backpressure: true
      })
    })
  }
}
