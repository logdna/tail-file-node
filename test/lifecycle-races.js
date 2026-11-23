'use strict'

const fs = require('fs')
const path = require('path')
const {promisify} = require('util')
const {Readable} = require('stream')
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
      timer = setTimeout(() => { reject(new Error('Lifecycle test deadline')) }, 1500)
    })
  ]).finally(() => { clearTimeout(timer) })
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1500
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Lifecycle state deadline')
    await immediate()
  }
}

function fixture(t, opts = {}, filename, createSource) {
  filename = filename || path.join(t.testdir({'active.log': ''}), 'active.log')
  const handles = []
  const sources = []
  const release = []
  const originalOpen = fs.promises.open
  const originalCreate = fs.createReadStream
  fs.promises.open = async (...args) => {
    const handle = await originalOpen(...args)
    if (args[0] === filename) handles.push(handle)
    return handle
  }
  fs.createReadStream = (...args) => {
    const source = (createSource || originalCreate)(...args)
    source.on('error', () => {}) // Disposal must not create an unhandled source error.
    sources.push(source)
    return source
  }
  const tail = new TailFile(filename, {
    pollFileIntervalMs: 60000
  , highWaterMark: 1
  , readStreamOpts: {highWaterMark: 1}
  , ...opts
  })
  const errors = []
  tail.on('error', (error) => { errors.push(error) })
  t.teardown(async () => {
    for (const unblock of release) unblock()
    tail.destroy()
    fs.promises.open = originalOpen
    fs.createReadStream = originalCreate
    for (const symbol of Object.getOwnPropertySymbols(tail)) {
      if (symbol.description === 'pollTimer') clearTimeout(tail[symbol])
    }
    for (const source of sources) source.destroy()
    await bounded(Promise.all(handles.map((handle) => {
      return handle.close().catch(() => {})
    }))).catch(() => {})
    await waitFor(() => { return sources.every((source) => { return source.closed }) })
  })
  return {tail, filename, handles, sources, errors, release}
}

async function ready(tail) {
  const flushed = new Promise((resolve) => { tail.once('flush', resolve) })
  await bounded(tail.start())
  await bounded(flushed)
}

function poll(tail) {
  const pending = tail._pollFileForChanges()
  pending.catch(() => {}) // Cancellation is observed through the public shutdown API.
  return pending
}

for (const emitClose of [true, false]) {
  test(`Pending rotation read settles before cleanup; emitClose=${emitClose}`, async (t) => {
    const {tail, filename, handles, release} = fixture(t, {emitClose})
    await ready(tail)
    await fs.promises.appendFile(filename, 'old remainder')
    await fs.promises.rename(filename, `${filename}.1`)
    await fs.promises.writeFile(filename, 'replacement')
    const handle = handles[0]
    const read = handle.read.bind(handle)
    const entered = deferred()
    const finish = deferred()
    release.push(finish.resolve)
    handle.read = async (...args) => {
      entered.resolve()
      await finish.promise
      return read(...args)
    }
    let emitted = 0
    let closeEvents = 0
    let closedDescriptorAtEvent
    tail.on('data', () => { emitted++ })
    tail.on('close', () => {
      closeEvents++
      closedDescriptorAtEvent = handle.fd === -1
    })
    const closed = emitClose
      ? new Promise((resolve) => { tail.once('close', resolve) })
      : null
    const pending = poll(tail)
    await bounded(entered.promise)
    tail.destroy()
    await immediate()
    t.equal(tail.closed, false, 'cleanup waits while a read result is pending')
    t.not(handle.fd, -1, 'descriptor stays valid until that read settles')
    finish.resolve()
    await bounded(pending.catch(() => {}))
    if (closed) await bounded(closed)
    else await waitFor(() => { return tail.closed })
    t.equal(handle.fd, -1, 'rotated descriptor is then closed')
    t.equal(emitted, 0, 'pending data is not emitted after cancellation')
    t.equal(closeEvents, emitClose ? 1 : 0)
    if (emitClose) t.equal(closedDescriptorAtEvent, true)
  })
}

test('Repeated quit calls share the final read and handle cleanup', async (t) => {
  const {tail, filename, handles} = fixture(t)
  await ready(tail)
  await fs.promises.appendFile(filename, 'contents')
  poll(tail)
  await waitFor(() => { return tail.readableLength > 0 })
  const close = handles[0].close.bind(handles[0])
  let closes = 0
  handles[0].close = async () => {
    closes++
    return close()
  }
  const first = tail.quit()
  const second = tail.quit()
  first.catch(() => {})
  second.catch(() => {})
  const chunks = []
  tail.on('data', (chunk) => { chunks.push(chunk) })
  await bounded(Promise.all([first, second]))
  t.equal(Buffer.concat(chunks).toString(), 'contents')
  t.equal(closes, 1, 'one shutdown owner closes the active handle')
})

test('A flush listener can reenter quit without starting another shutdown', async (t) => {
  const {tail, filename, handles} = fixture(t)
  await ready(tail)
  await fs.promises.appendFile(filename, 'final bytes')
  const chunks = []
  tail.on('data', (chunk) => { chunks.push(chunk) })
  let reentered
  let closes = 0
  const close = handles[0].close.bind(handles[0])
  handles[0].close = async () => {
    closes++
    return close()
  }
  tail.once('flush', () => {
    reentered = tail.quit()
    reentered.catch(() => {})
  })
  await bounded(tail.quit())
  t.ok(reentered, 'the listener ran during the final flush')
  await bounded(reentered)
  t.equal(Buffer.concat(chunks).toString(), 'final bytes')
  t.equal(closes, 1)
})

test('Cancellation preserves the supplied error object and emits it once', async (t) => {
  const {tail, filename, errors} = fixture(t)
  await ready(tail)
  await fs.promises.appendFile(filename, Buffer.alloc(32, 65))
  poll(tail)
  await waitFor(() => { return tail.readableLength > 0 })
  const error = new Error('supplied cancellation')
  const quitting = tail.quit()
  const rejection = quitting.then(() => {
    throw new Error('Interrupted quit unexpectedly resolved')
  }, (actual) => { return actual })
  const emitted = new Promise((resolve) => { tail.once('error', resolve) })
  const closed = new Promise((resolve) => { tail.once('close', resolve) })
  tail.destroy(error)
  t.equal(await bounded(rejection), error)
  t.equal(await bounded(emitted), error)
  await bounded(closed)
  t.same(errors, [error])
})

test('A failed final read rejects quit and reports one tail_error', async (t) => {
  const {tail, filename, sources} = fixture(t, {highWaterMark: 64})
  await ready(tail)
  const error = Object.assign(new Error('final read failed'), {code: 'EIO'})
  const reported = []
  const chunks = []
  tail.on('tail_error', (actual) => { reported.push(actual) })
  tail.once('data', (chunk) => {
    chunks.push(chunk)
    sources[0].destroy(error)
  })
  await fs.promises.appendFile(filename, Buffer.alloc(128, 65))
  const actual = await bounded(tail.quit().then(() => {
    throw new Error('Failed final read unexpectedly resolved')
  }, (failure) => { return failure }))
  t.equal(actual, error)
  t.equal(reported.length, 1)
  t.equal(reported[0].code, 'ETAIL')
  t.equal(reported[0].meta.actual, error)
  t.ok(chunks.length, 'the error follows actual read progress')
})

test('A queued flush is not emitted after destruction', async (t) => {
  const {tail} = fixture(t)
  let destroyed = false
  let lateFlushes = 0
  tail.on('flush', () => { if (destroyed) lateFlushes++ })
  await bounded(tail.start())
  destroyed = true
  tail.destroy()
  await waitFor(() => { return tail.closed })
  await immediate()
  await immediate()
  t.equal(lateFlushes, 0)
})

test('Initial fatal stat errors reject start without an error listener', async (t) => {
  const {tail, filename} = fixture(t)
  tail.removeAllListeners('error')
  const error = Object.assign(new Error('initial stat failed'), {code: 'EACCES'})
  const stat = fs.promises.stat
  t.teardown(() => { fs.promises.stat = stat })
  fs.promises.stat = async (...args) => {
    if (args[0] === filename) throw error
    return stat(...args)
  }
  const actual = await bounded(tail.start().then(() => { return null }, (failure) => {
    return failure
  }))
  t.equal(actual, error, 'startup does not silently accept the failed initial poll')
})

test('A final stat failure preserves error/end and permits reentrant quit', async (t) => {
  const {tail, filename, handles, errors} = fixture(t)
  await ready(tail)
  const error = Object.assign(new Error('final stat failed'), {code: 'EACCES'})
  const stat = fs.promises.stat
  t.teardown(() => { fs.promises.stat = stat })
  fs.promises.stat = async (...args) => {
    if (args[0] === filename) throw error
    return stat(...args)
  }
  const events = []
  let reentered
  tail.on('error', () => {
    events.push('error')
    reentered = tail.quit()
    reentered.catch(() => {})
  })
  tail.on('end', () => { events.push('end') })
  const closed = new Promise((resolve) => {
    tail.once('close', () => {
      events.push('close')
      resolve()
    })
  })
  await new Promise((resolve) => {
    tail.once('resume', resolve)
    tail.resume()
  })
  const actual = await bounded(tail.quit().then(() => { return null }, (failure) => {
    return failure
  }))
  await bounded(closed)
  t.equal(actual, error)
  t.ok(reentered)
  t.equal(await bounded(reentered.catch((failure) => { return failure })), error)
  t.same(errors, [error])
  t.same(events, ['error', 'end', 'close'])
  t.ok(handles.every((handle) => { return handle.fd === -1 }))
})

test('Cancelling quit during a pathname stat prevents a final read', async (t) => {
  const {tail, filename, sources, release} = fixture(t)
  await ready(tail)
  await fs.promises.appendFile(filename, 'must not be read')
  const stat = fs.promises.stat
  t.teardown(() => { fs.promises.stat = stat })
  const entered = deferred()
  const finish = deferred()
  release.push(finish.resolve)
  let calls = 0
  fs.promises.stat = async (...args) => {
    if (args[0] === filename) {
      calls++
      entered.resolve()
      await finish.promise
    }
    return stat(...args)
  }
  const notifications = []
  for (const event of ['data', 'flush', 'renamed', 'truncated', 'retry']) {
    tail.on(event, () => { notifications.push(event) })
  }
  const active = poll(tail)
  await bounded(entered.promise)
  const rejection = tail.quit().catch((failure) => { return failure })
  const closed = new Promise((resolve) => { tail.once('close', resolve) })
  await immediate() // Let quit wait on the active stat before cancellation.
  tail.destroy()
  finish.resolve()
  const error = await bounded(rejection)
  await bounded(active.catch(() => {}))
  await bounded(closed)
  await immediate()
  t.equal(error.code, 'ABORT_ERR')
  t.equal(calls, 1, 'shutdown does not start another stat after cancellation')
  t.equal(sources.length, 0)
  t.same(notifications, [])
})

for (const event of ['renamed', 'truncated']) {
  test(`Cancellation from ${event} prevents opening a new source`, async (t) => {
    const {tail, filename, handles, sources} = fixture(t)
    if (event === 'truncated') await fs.promises.writeFile(filename, 'old contents')
    await ready(tail)
    if (event === 'renamed') {
      await fs.promises.rename(filename, `${filename}.1`)
      await fs.promises.writeFile(filename, 'replacement')
    } else {
      await fs.promises.writeFile(filename, 'x')
    }
    let emitted = 0
    let notified = 0
    tail.on('data', () => { emitted++ })
    tail.on(event, () => {
      notified++
      tail.destroy()
    })
    const closed = new Promise((resolve) => { tail.once('close', resolve) })
    await bounded(poll(tail).catch(() => {}))
    await bounded(closed)
    t.equal(notified, 1)
    t.equal(sources.length, 0, 'the listener stops the pending file-stream read')
    t.equal(emitted, 0)
    t.ok(handles.every((handle) => { return handle.fd === -1 }))
  })
}

test('A late iterator chunk is discarded after cancellation', async (t) => {
  const entered = deferred()
  const finish = deferred()
  let delivered = false
  let source
  const state = fixture(t, {}, undefined, (filename, options) => {
    source = new Readable({read() {}, emitClose: options.emitClose})
    source.iterator = () => {
      return {
        [Symbol.asyncIterator]() { return this }
      , async next() {
          if (delivered) return {done: true}
          entered.resolve()
          await finish.promise
          delivered = true
          return {value: Buffer.from('late bytes'), done: false}
        }
      , async return() { return {done: true} }
      }
    }
    return source
  })
  const {tail, filename, handles, release} = state
  release.push(finish.resolve)
  await ready(tail)
  await fs.promises.appendFile(filename, 'late bytes')
  let emitted = 0
  tail.on('data', () => { emitted++ })
  const pending = poll(tail)
  await bounded(entered.promise)
  const closed = new Promise((resolve) => { tail.once('close', resolve) })
  tail.destroy()
  await immediate()
  t.equal(tail.closed, false, 'cleanup waits for the pending iterator result')
  finish.resolve()
  await bounded(pending.catch(() => {}))
  await bounded(closed)
  t.equal(emitted, 0)
  t.equal(source.closed, true, 'private source finishes cleanup')
  t.ok(handles.every((handle) => { return handle.fd === -1 }))
})

test('A late ordinary read error after cancellation is suppressed', async (t) => {
  const entered = deferred()
  const finish = deferred()
  const error = Object.assign(new Error('late read failure'), {code: 'EIO'})
  const implementation = {
    open: fs.open.bind(fs)
  , close: fs.close.bind(fs)
  , read(fd, buffer, offset, length, position, callback) {
      entered.resolve()
      finish.promise.then(() => { callback(error, 0, buffer) })
    }
  }
  const state = fixture(t, {readStreamOpts: {highWaterMark: 1, fs: implementation}})
  const {tail, filename, handles, sources, release, errors} = state
  release.push(finish.resolve)
  await ready(tail)
  await fs.promises.appendFile(filename, 'unread')
  const reported = []
  let emitted = 0
  tail.on('tail_error', (failure) => { reported.push(failure) })
  tail.on('data', () => { emitted++ })
  const pending = poll(tail)
  await bounded(entered.promise)
  const closed = new Promise((resolve) => { tail.once('close', resolve) })
  tail.destroy()
  await immediate()
  t.equal(tail.closed, false, 'cleanup waits for the native source read callback')
  finish.resolve()
  await bounded(pending.catch(() => {}))
  await bounded(closed)
  await immediate()
  t.same(reported, [])
  t.same(errors, [])
  t.equal(emitted, 0)
  t.ok(sources.every((stream) => { return stream.closed && stream.fd === null }))
  t.ok(handles.every((handle) => { return handle.fd === -1 }))
})

test('Cancellation during replacement-open handoff suppresses resumption', async (t) => {
  const {tail, filename, handles, sources} = fixture(t)
  await ready(tail)
  await fs.promises.rename(filename, `${filename}.1`)
  await fs.promises.writeFile(filename, 'replacement')
  const open = fs.promises.open
  t.teardown(() => { fs.promises.open = open })
  let returned = false
  fs.promises.open = async (...args) => {
    const handle = await open(...args)
    if (args[0] === filename) {
      returned = true
      // Allow the open helper to receive its handle, then cancel before the
      // awaiting poll resumes with the replacement. No private state is changed.
      queueMicrotask(() => { queueMicrotask(() => { tail.destroy() }) })
    }
    return handle
  }
  const notifications = []
  for (const event of ['renamed', 'data', 'flush', 'retry']) {
    tail.on(event, () => { notifications.push(event) })
  }
  const closed = new Promise((resolve) => { tail.once('close', resolve) })
  await bounded(poll(tail).catch(() => {}))
  await bounded(closed)
  await immediate()
  t.equal(returned, true, 'the replacement open completed')
  t.equal(handles.length, 2)
  t.ok(handles.every((handle) => { return handle.fd === -1 }))
  t.equal(sources.length, 0)
  t.same(notifications, [])
})

test('A queued poll attempt after destruction remains inert', async (t) => {
  const {tail, sources} = fixture(t)
  await ready(tail)
  const closed = new Promise((resolve) => { tail.once('close', resolve) })
  tail.destroy()
  await bounded(closed)
  const stat = fs.promises.stat
  const timeout = global.setTimeout
  let stats = 0
  let timers = 0
  fs.promises.stat = async (...args) => {
    stats++
    return stat(...args)
  }
  global.setTimeout = (callback, ms, ...args) => {
    if (ms === 60000) timers++
    return timeout(callback, ms, ...args)
  }
  t.teardown(() => {
    fs.promises.stat = stat
    global.setTimeout = timeout
  })
  const notifications = []
  for (const event of ['data', 'flush', 'renamed', 'truncated', 'retry']) {
    tail.on(event, () => { notifications.push(event) })
  }
  await bounded(poll(tail))
  await immediate()
  await immediate()
  t.equal(stats, 0)
  t.equal(timers, 0)
  t.equal(sources.length, 0)
  t.same(notifications, [])
})

for (const kind of ['number', 'FileHandle']) {
  for (const emitClose of [true, false]) {
    test(`Borrowed ${kind}; autoClose:false, emitClose:${emitClose}`, async (t) => {
      const filename = path.join(t.testdir({'active.log': ''}), 'active.log')
      const borrowed = kind === 'number'
        ? fs.openSync(filename, 'r')
        : await fs.promises.open(filename, 'r')
      let callerClosed = false
      t.teardown(async () => {
        if (callerClosed) return
        try {
          if (kind === 'number') fs.closeSync(borrowed)
          else await bounded(borrowed.close())
          callerClosed = true
        } catch (error) {
          if (error.code !== 'EBADF') throw error
        }
      })
      const {tail} = fixture(t, {
        emitClose
      , readStreamOpts: {fd: borrowed, autoClose: false, highWaterMark: 1, emitClose}
      }, filename)
      await ready(tail)
      await fs.promises.appendFile(filename, 'caller-owned bytes')
      poll(tail)
      await waitFor(() => { return tail.readableLength > 0 })
      tail.destroy()
      await waitFor(() => { return tail.closed })
      const stats = kind === 'number'
        ? fs.fstatSync(borrowed)
        : await bounded(borrowed.stat())
      t.equal(stats.size, Buffer.byteLength('caller-owned bytes'))
      if (kind === 'number') {
        fs.closeSync(borrowed)
        callerClosed = true
      } else {
        await bounded(borrowed.close())
        callerClosed = true
        t.equal(borrowed.fd, -1, 'caller can finish closing its handle')
      }
    })
  }
}

test('A borrowed numeric source preserves custom read binding', async (t) => {
  const filename = path.join(t.testdir({'active.log': ''}), 'active.log')
  const fd = fs.openSync(filename, 'r')
  let closed = false
  t.teardown(() => { if (!closed) fs.closeSync(fd) })
  let correctlyBound = true
  let reads = 0
  let closes = 0
  const implementation = {
    read(...args) {
      correctlyBound = correctlyBound && this === implementation
      reads++
      fs.read(...args)
    }
  , close(...args) {
      closes++
      fs.close(...args)
    }
  }
  const {tail} = fixture(t, {
    emitClose: false
  , readStreamOpts: {fd, autoClose: false, highWaterMark: 1, fs: implementation}
  }, filename)
  await ready(tail)
  await fs.promises.appendFile(filename, 'custom read')
  poll(tail)
  await waitFor(() => { return tail.readableLength > 0 })
  tail.destroy()
  await waitFor(() => { return tail.closed })
  t.ok(reads)
  t.equal(correctlyBound, true)
  t.equal(closes, 0, 'caller retains descriptor ownership')
  t.equal(fs.fstatSync(fd).size, Buffer.byteLength('custom read'))
  fs.closeSync(fd)
  closed = true
})

test('A borrowed FileHandle read failure is reported without closing it', async (t) => {
  const filename = path.join(t.testdir({'active.log': ''}), 'active.log')
  const handle = await fs.promises.open(filename, 'r')
  t.teardown(() => { return handle.close() })
  const error = Object.assign(new Error('borrowed read failed'), {code: 'EIO'})
  const read = fs.read
  const borrowedFd = handle.fd
  fs.read = (fd, buffer, offset, length, position, callback) => {
    if (fd === borrowedFd) {
      process.nextTick(callback, error, 0, buffer)
      return
    }
    return read(fd, buffer, offset, length, position, callback)
  }
  t.teardown(() => { fs.read = read })
  const {tail} = fixture(t, {
    readStreamOpts: {fd: handle, autoClose: false, highWaterMark: 1}
  }, filename)
  await ready(tail)
  const reported = []
  tail.on('tail_error', (actual) => { reported.push(actual) })
  await fs.promises.appendFile(filename, 'unread')
  const actual = await bounded(tail.quit().then(() => {
    throw new Error('Failed borrowed read unexpectedly resolved')
  }, (failure) => { return failure }))
  t.equal(actual, error)
  t.equal(reported.length, 1)
  t.equal(reported[0].meta.actual, error)
  t.not(handle.fd, -1)
  t.equal((await handle.stat()).size, Buffer.byteLength('unread'))
  await bounded(handle.close())
  t.equal(handle.fd, -1)
})
