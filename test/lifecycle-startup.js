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
      timer = setTimeout(() => { reject(new Error('Startup test deadline')) }, 2000)
    })
  ]).finally(() => { clearTimeout(timer) })
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Startup state deadline')
    await immediate()
  }
}

function fixture(t, opts = {}, filename) {
  filename = filename || path.join(t.testdir({'active.log': ''}), 'active.log')
  const tail = new TailFile(filename, {pollFileIntervalMs: 60000, ...opts})
  const errors = []
  const handles = []
  const release = deferred()
  const entered = deferred()
  const originalOpen = fs.promises.open
  const originalStat = fs.promises.stat
  let starting
  tail.on('error', (error) => { errors.push(error) })
  t.teardown(async () => {
    release.resolve()
    tail.destroy()
    if (starting) await bounded(starting).catch(() => {})
    await waitFor(() => { return tail.closed })
    fs.promises.open = originalOpen
    fs.promises.stat = originalStat
    for (const handle of handles) await handle.close().catch(() => {})
  })
  return {
    filename
  , tail
  , handles
  , errors
  , release
  , entered
  , originalOpen
  , originalStat
  , start() {
      starting = tail.start()
      starting.catch(() => {})
      return starting
    }
  }
}

test('A failed pending open rejects both startup and graceful shutdown', async (t) => {
  const state = fixture(t)
  const {tail, filename, entered, release, originalOpen} = state
  const error = Object.assign(new Error('Pending open failed'), {code: 'EACCES'})
  fs.promises.open = async (...args) => {
    if (args[0] === filename) {
      entered.resolve()
      await release.promise
      throw error
    }
    return originalOpen(...args)
  }
  const starting = state.start().catch((actual) => { return actual })
  await bounded(entered.promise)
  const quitting = tail.quit().catch((actual) => { return actual })
  await immediate()
  release.resolve()
  t.equal(await bounded(starting), error)
  t.equal(await bounded(quitting), error)
})

for (const fails of [false, true]) {
  for (const suppliedError of [false, true]) {
    for (const emitClose of [false, true]) {
      const label = `Pending open: failure=${fails}, error=${suppliedError}, close=${emitClose}`
      test(label, async (t) => {
        const state = fixture(t, {emitClose})
        const {filename, tail, handles, errors, entered, release, originalOpen} = state
        const openError = Object.assign(new Error('Open failed'), {code: 'EACCES'})
        const cancellation = suppliedError ? new Error('Cancel startup') : undefined
        fs.promises.open = async (...args) => {
          if (args[0] === filename) {
            entered.resolve()
            await release.promise
            if (fails) throw openError
          }
          const handle = await originalOpen(...args)
          if (args[0] === filename) handles.push(handle)
          return handle
        }
        let closeEvents = 0
        let handlesClosedAtClose
        const closed = new Promise((resolve) => {
          tail.once('close', () => {
            closeEvents++
            handlesClosedAtClose = handles.every((handle) => { return handle.fd === -1 })
            resolve()
          })
        })
        const rejected = state.start().then(() => {
          throw new Error('Cancelled startup resolved')
        }, (error) => { return error })
        await bounded(entered.promise)
        tail.destroy(cancellation)
        await immediate()
        t.equal(tail.closed, false, 'pending open completes before destruction does')
        release.resolve()
        const actual = await bounded(rejected)
        if (suppliedError) t.equal(actual, cancellation, 'same cancellation error')
        else t.match(actual, {name: 'AbortError', code: 'ABORT_ERR'})
        if (emitClose) await bounded(closed)
        else await waitFor(() => { return tail.closed })
        await immediate()
        t.equal(handles.length, fails ? 0 : 1)
        t.ok(handles.every((handle) => { return handle.fd === -1 }), 'handles closed')
        t.equal(closeEvents, emitClose ? 1 : 0)
        if (emitClose) t.equal(handlesClosedAtClose, true, 'cleanup before close event')
        t.same(errors, suppliedError ? [cancellation] : [])
      })
    }
  }
}

test('Repeated start calls share one pending open', async (t) => {
  const state = fixture(t)
  const {filename, tail, handles, entered, release, originalOpen} = state
  let opens = 0
  fs.promises.open = async (...args) => {
    if (args[0] === filename) {
      opens++
      entered.resolve()
      await release.promise
    }
    const handle = await originalOpen(...args)
    if (args[0] === filename) handles.push(handle)
    return handle
  }
  const first = state.start()
  const second = tail.start()
  await bounded(entered.promise)
  release.resolve()
  await bounded(Promise.all([first, second]))
  t.equal(opens, 1)
  t.equal(handles.length, 1)
  tail.resume()
  await bounded(tail.quit())
  t.equal(handles[0].fd, -1)
})

test('A tail destroyed before start rejects without opening a file', async (t) => {
  const state = fixture(t)
  const {filename, tail, originalOpen} = state
  let opens = 0
  fs.promises.open = (...args) => {
    if (args[0] === filename) opens++
    return originalOpen(...args)
  }
  tail.destroy()
  await t.rejects(state.start(), {name: 'AbortError', code: 'ABORT_ERR'})
  t.equal(opens, 0)
})

test('Startup can retry after an ordinary initial open failure', async (t) => {
  const filename = path.join(t.testdir({}), 'later.log')
  const state = fixture(t, {}, filename)
  const {tail, handles, originalOpen} = state
  let opens = 0
  fs.promises.open = async (...args) => {
    if (args[0] === filename) opens++
    const handle = await originalOpen(...args)
    if (args[0] === filename) handles.push(handle)
    return handle
  }
  await t.rejects(state.start(), {code: 'ENOENT'})
  await fs.promises.writeFile(filename, 'now accessible')
  await bounded(state.start())
  t.equal(opens, 2, 'retry performs another open')
  t.equal(handles.length, 1)
  tail.resume()
  await bounded(tail.quit())
  t.equal(handles[0].fd, -1)
})

test('Handled fatal startup polling preserves flowing event order', async (t) => {
  const state = fixture(t)
  const {filename, tail, handles, errors, originalOpen, originalStat} = state
  const failure = Object.assign(new Error('Initial stat failed'), {code: 'EACCES'})
  fs.promises.open = async (...args) => {
    const handle = await originalOpen(...args)
    if (args[0] === filename) handles.push(handle)
    return handle
  }
  fs.promises.stat = async (...args) => {
    if (args[0] === filename) throw failure
    return originalStat(...args)
  }
  const events = []
  tail.on('error', () => { events.push('error') })
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
  await bounded(state.start())
  await bounded(closed)
  t.same(errors, [failure])
  t.same(events, ['error', 'end', 'close'])
  t.equal(handles[0].fd, -1)
})

for (const fails of [false, true]) {
  test(`Cancellation during the initial pathname check; stat fails=${fails}`, async (t) => {
    const state = fixture(t)
    const {filename, tail, handles, entered, release, originalOpen, originalStat} = state
    const cancellation = new Error('Cancel initial stat')
    const statError = Object.assign(new Error('Delayed stat failed'), {code: 'EIO'})
    fs.promises.open = async (...args) => {
      const handle = await originalOpen(...args)
      if (args[0] === filename) handles.push(handle)
      return handle
    }
    fs.promises.stat = async (...args) => {
      if (args[0] === filename) {
        entered.resolve()
        await release.promise
        if (fails) throw statError
      }
      return originalStat(...args)
    }
    const rejected = state.start().then(() => {
      throw new Error('Cancelled startup resolved')
    }, (error) => { return error })
    const closed = new Promise((resolve) => { tail.once('close', resolve) })
    await bounded(entered.promise)
    tail.destroy(cancellation)
    await immediate()
    t.equal(tail.closed, false)
    release.resolve()
    t.equal(await bounded(rejected), cancellation)
    await bounded(closed)
    t.equal(handles[0].fd, -1)
  })
}

test('Error quit during a pending initial open releases the late handle', async (t) => {
  const state = fixture(t, {startPos: 0})
  const {filename, tail, handles, errors, entered, release, originalOpen} = state
  const failure = new Error('Stop startup through legacy quit')
  fs.promises.open = async (...args) => {
    if (args[0] === filename) {
      entered.resolve()
      await release.promise
    }
    const handle = await originalOpen(...args)
    if (args[0] === filename) handles.push(handle)
    return handle
  }
  const events = []
  tail.on('error', () => { events.push('error') })
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
  const startupError = state.start().then(() => {
    throw new Error('Stopped startup resolved')
  }, (error) => { return error })
  await bounded(entered.promise)
  let quitSettled = false
  const quitting = tail.quit(failure).then(() => { quitSettled = true })
  await immediate()
  t.equal(quitSettled, false, 'error quit waits for the pending open')
  release.resolve()
  t.match(await bounded(startupError), {name: 'AbortError', code: 'ABORT_ERR'})
  await bounded(quitting)
  await bounded(closed)
  t.same(errors, [failure])
  t.same(events, ['error', 'end', 'close'])
  t.equal(handles[0].fd, -1)
})

test('A completed quit cannot restart or open a new handle', async (t) => {
  const state = fixture(t)
  const {filename, tail, originalOpen} = state
  let opens = 0
  fs.promises.open = (...args) => {
    if (args[0] === filename) opens++
    return originalOpen(...args)
  }
  tail.resume()
  await bounded(tail.quit())
  await t.rejects(state.start(), {name: 'AbortError', code: 'ABORT_ERR'})
  t.equal(opens, 0)
})

test('Graceful quit waits for startup opening and drains initial bytes', async (t) => {
  const state = fixture(t, {startPos: 0, highWaterMark: 1})
  const {filename, tail, handles, errors, entered, release, originalOpen} = state
  fs.promises.open = async (...args) => {
    if (args[0] === filename) {
      entered.resolve()
      await release.promise
    }
    const handle = await originalOpen(...args)
    if (args[0] === filename) handles.push(handle)
    return handle
  }
  const expected = 'bytes written during initial open €😀'
  const chunks = []
  tail.on('data', (chunk) => { chunks.push(chunk) })
  const starting = state.start()
  await bounded(entered.promise)
  await fs.promises.appendFile(filename, expected)
  let quitSettled = false
  const quitting = tail.quit().then(() => { quitSettled = true })
  await immediate()
  t.equal(quitSettled, false, 'graceful quit waits for startup')
  release.resolve()
  await bounded(Promise.all([starting, quitting]))
  t.equal(Buffer.concat(chunks).toString(), expected)
  t.equal(handles.length, 1)
  t.equal(handles[0].fd, -1)
  t.same(errors, [])
})

for (const stop of ['quit', 'destroy']) {
  test(`Startup stops during the open-to-ready handoff: ${stop}`, async (t) => {
    const state = fixture(t)
    const {filename, tail, handles, errors, originalOpen} = state
    const failure = new Error('Stop during startup handoff')
    let stopping
    fs.promises.open = async (...args) => {
      const handle = await originalOpen(...args)
      if (args[0] === filename) {
        handles.push(handle)
        queueMicrotask(() => {
          if (stop === 'quit') {
            stopping = tail.quit(failure)
            stopping.catch(() => {})
          } else {
            tail.destroy(failure)
          }
        })
      }
      return handle
    }
    const closed = new Promise((resolve) => { tail.once('close', resolve) })
    await new Promise((resolve) => {
      tail.once('resume', resolve)
      tail.resume()
    })
    const actual = await bounded(state.start().then(() => {
      throw new Error('Stopped startup resolved')
    }, (error) => { return error }))
    if (stop === 'quit') {
      t.match(actual, {name: 'AbortError', code: 'ABORT_ERR'})
      await bounded(stopping)
    } else {
      t.equal(actual, failure, 'destroy preserves the supplied cancellation error')
    }
    await bounded(closed)
    t.same(errors, [failure])
    t.equal(handles.length, 1)
    t.equal(handles[0].fd, -1, 'the handoff does not retain an open handle')
  })
}
