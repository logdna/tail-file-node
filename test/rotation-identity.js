'use strict'

const fs = require('fs')
const path = require('path')
const {promisify} = require('util')
const {test} = require('tap')
const TailFile = require('../index.js')
const getSymbols = require('./get-symbols.js')
const immediate = promisify(setImmediate)
const FIRST_INODE = global.BigInt('11821949022204663')
const NEXT_INODE = global.BigInt('11821949022204664')

async function waitFor(predicate) {
  const deadline = Date.now() + 1500
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for a paused read')
    await immediate()
  }
}

async function fixture(t, opts = {}, initial_inode = FIRST_INODE) {
  const filename = path.join(t.testdir({'active.log': ''}), 'active.log')
  const stat = fs.promises.stat
  let inode = initial_inode
  // Exercise native files and reads; only the pathname identity is controlled.
  // Returning the rounded value unless bigint is requested reproduces the bug
  // independently of the IDs allocated by the host filesystem.
  fs.promises.stat = async (file, options) => {
    const result = await stat(file, options)
    if (file !== filename) return result
    return {...result, ino: options && options.bigint ? inode : Number(inode)}
  }
  const tail = new TailFile(filename, {
    pollFileIntervalMs: 60000
  , highWaterMark: 7
  , readStreamOpts: {highWaterMark: 3}
  , ...opts
  })
  const symbols = getSymbols(tail)
  t.teardown(async () => {
    tail.resume()
    try {
      await tail.quit()
    } finally {
      clearTimeout(tail[symbols.pollTimer])
      fs.promises.stat = stat
    }
  })
  const ready = new Promise((resolve) => { tail.once('flush', resolve) })
  await tail.start()
  await ready
  const flushes = []
  tail.on('flush', (event) => { flushes.push(event.lastReadPosition) })
  return {tail, filename, symbols, flushes, identity: (next) => { inode = next }}
}

async function poll(tail) {
  const result = await tail._pollFileForChanges()
  if (result.flush) await result.flush
}

async function rotate(state, old_bytes, new_bytes, inode = NEXT_INODE) {
  await fs.promises.appendFile(state.filename, old_bytes)
  await fs.promises.rename(state.filename, `${state.filename}.1`)
  await fs.promises.writeFile(state.filename, new_bytes)
  state.identity(inode)
}

test('Rotation distinguishes inode IDs that round to the same Number', async (t) => {
  const state = await fixture(t)
  const {tail, flushes} = state
  const old_bytes = Buffer.from('unread old: €😀\n')
  const new_bytes = Buffer.from('replacement: 終\n')
  const chunks = []
  let renamed = 0
  tail.on('data', (chunk) => { chunks.push(chunk) })
  tail.on('renamed', () => { renamed++ })
  t.equal(Number(FIRST_INODE), Number(NEXT_INODE), 'the two numeric IDs collide')
  await rotate(state, old_bytes, new_bytes)
  await poll(tail)
  await poll(tail)
  t.same(
    Buffer.concat(chunks)
  , Buffer.concat([old_bytes, new_bytes])
  , 'ordered bytes once'
  )
  t.equal(renamed, 1, 'one replacement is detected')
  t.same(flushes, [new_bytes.length, new_bytes.length], 'public positions stay numeric')
})

test('An unchanged unsafe inode does not replay appended bytes', async (t) => {
  const {tail, filename, flushes} = await fixture(t)
  const bytes = Buffer.from('appended: €😀\n')
  const chunks = []
  let renamed = 0
  tail.on('data', (chunk) => { chunks.push(chunk) })
  tail.on('renamed', () => { renamed++ })
  await fs.promises.appendFile(filename, bytes)
  await poll(tail)
  await poll(tail)
  t.same(Buffer.concat(chunks), bytes, 'the append is delivered exactly once')
  t.equal(renamed, 0, 'the same exact identity does not look like a replacement')
  t.same(flushes, [bytes.length, bytes.length], 'ordinary read positions stay numeric')
})

test('Truncation with an unchanged unsafe inode retains numeric positions', async (t) => {
  const {tail, filename, flushes} = await fixture(t)
  const first = Buffer.from('long initial content: €😀\n')
  const next = Buffer.from('終\n')
  const chunks = []
  let truncated = 0
  let renamed = 0
  tail.on('data', (chunk) => { chunks.push(chunk) })
  tail.on('truncated', () => { truncated++ })
  tail.on('renamed', () => { renamed++ })
  await fs.promises.appendFile(filename, first)
  await poll(tail)
  await fs.promises.writeFile(filename, next)
  await poll(tail)
  await poll(tail)
  t.same(Buffer.concat(chunks), Buffer.concat([first, next]), 'truncation bytes once')
  t.equal(truncated, 1)
  t.equal(renamed, 0)
  t.same(flushes, [first.length, next.length, next.length])
})

test('Rotation with colliding numeric inode IDs respects backpressure', async (t) => {
  const state = await fixture(t)
  const {tail, symbols, flushes} = state
  const old_bytes = Buffer.from('old €😀\n'.repeat(16))
  const new_bytes = Buffer.from('replacement bytes\n')
  const handle = tail[symbols.fileHandle]
  const read = handle.read.bind(handle)
  const requests = []
  handle.read = (buffer, offset, length, position) => {
    requests.push({allocation: buffer.length, length, position})
    return read(buffer, offset, length, position)
  }
  await rotate(state, old_bytes, new_bytes)
  const pending = poll(tail)
  await waitFor(() => { return tail[symbols.demand] })
  t.ok(requests.length > 0, 'the open rotated handle is read')
  const paused_at = requests.length
  await immediate()
  t.equal(requests.length, paused_at, 'no remainder read while backpressured')
  const chunks = []
  tail.on('data', (chunk) => { chunks.push(chunk) })
  await pending
  t.same(Buffer.concat(chunks), Buffer.concat([old_bytes, new_bytes]), 'resumed bytes')
  t.ok(requests.every((request) => {
    return request.allocation <= 7 && request.length <= 7
      && typeof request.position === 'number'
  }), 'remainder allocations and numeric positions retain their bounds')
  t.equal(handle.fd, -1, 'the old handle closes after the remainder drains')
  t.same(flushes, [new_bytes.length])
})

test('A zero inode remains an initialized file identity', async (t) => {
  const state = await fixture(t, {}, global.BigInt(0))
  const {tail} = state
  const old_bytes = Buffer.from('zero-inode remainder\n')
  const new_bytes = Buffer.from('replacement\n')
  const chunks = []
  let renamed = 0
  tail.on('data', (chunk) => { chunks.push(chunk) })
  tail.on('renamed', () => { renamed++ })
  await rotate(state, old_bytes, new_bytes, global.BigInt(1))
  await poll(tail)
  t.same(Buffer.concat(chunks), Buffer.concat([old_bytes, new_bytes]))
  t.equal(renamed, 1, 'zero is not confused with the uninitialized sentinel')
})
