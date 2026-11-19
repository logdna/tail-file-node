'use strict'

const fs = require('fs')
const path = require('path')
const {once} = require('events')
const {Writable} = require('stream')
const {promisify} = require('util')
const {test} = require('tap')
const TailFile = require('../index.js')
const getSymbols = require('./get-symbols.js')
const immediate = promisify(setImmediate)

async function waitFor(predicate) {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for read state')
    await immediate()
  }
}

async function setup(t, opts) {
  const filename = path.join(t.testdir({'active.log': ''}), 'active.log')
  const tail = new TailFile(filename, {
    pollFileIntervalMs: 100000
  , highWaterMark: 1024
  , readStreamOpts: {highWaterMark: 37}
  , ...opts
  })
  const symbols = getSymbols(tail)
  await tail.start()
  clearTimeout(tail[symbols.pollTimer])
  // Continue consumption so teardown can drain gracefully.
  t.teardown(async () => {
    tail.resume()
    if (!tail.destroyed && !tail._readableState.ended) await tail.quit()
    clearTimeout(tail[symbols.pollTimer])
    if (tail[symbols.fileHandle]) await tail[symbols.fileHandle].close()
  })
  return {tail, filename, symbols}
}

async function rotate(filename, oldBytes, newBytes = Buffer.from('replacement')) {
  await fs.promises.appendFile(filename, oldBytes)
  await fs.promises.rename(filename, `${filename}.1`)
  await fs.promises.writeFile(filename, newBytes)
}

test('Bounded rotation preserves UTF-8 bytes across short reads', async (t) => {
  const {tail, filename, symbols} = await setup(t)
  const oldBytes = Buffer.from('a€😀\n'.repeat(32768))
  const next = Buffer.from('new file\n')
  await rotate(filename, oldBytes, next)
  const handle = tail[symbols.fileHandle]
  const read = handle.read.bind(handle)
  const requests = []
  handle.read = async (buffer, offset, length, position) => {
    requests.push({allocation: buffer.length, length, position})
    return read(buffer, offset, Math.min(317, length), position)
  }
  const allocations = []
  const alloc = Buffer.alloc
  Buffer.alloc = (size, ...args) => {
    allocations.push(size)
    return alloc(size, ...args)
  }
  t.teardown(() => {
    Buffer.alloc = alloc
  })
  const polling = tail._pollFileForChanges()
  await waitFor(() => { return tail[symbols.demand] })
  t.equal(tail._pollFileForChanges(), polling, 'another poll shares the active drain')
  const count = requests.length
  await immediate()
  t.equal(requests.length, count, 'no reads while backpressured')
  t.equal(handle.fd >= 0, true, 'old handle remains open while paused')
  const chunks = []
  tail.on('data', (chunk) => { chunks.push(chunk) })
  await polling
  Buffer.alloc = alloc
  t.same(Buffer.concat(chunks), Buffer.concat([oldBytes, next]), 'exact ordered bytes')
  t.ok(allocations.every((size) => { return size <= 1024 }), 'bounded allocations')
  t.ok(chunks.every((chunk) => { return chunk.length <= 1024 }), 'bounded chunks')
  t.equal(requests[0].length, 1024, 'outer watermark controls rotation reads')
  t.ok(requests.every((req) => {
    return req.allocation <= 1024 && req.length <= 1024
  }), 'bounded buffers and requests')
  t.equal(requests[1].position, 317, 'advances by actual bytes read')
  t.equal(handle.fd, -1, 'old handle closed after draining')
})

test('Synthetic 1 GiB remainder and early EOF use bounded buffers', async (t) => {
  const {tail, symbols} = await setup(t, {highWaterMark: 257})
  const real = tail[symbols.fileHandle]
  const requests = []
  let closed = 0
  tail[symbols.fileHandle] = {
    stat: async () => { return {size: 1024 * 1024 * 1024} }
  , read: async (buffer, offset, length, position) => {
      requests.push({size: buffer.length, length, position})
      buffer.fill(65)
      return {bytesRead: position ? 0 : 3}
    }
  , close: async () => {
      closed++
      await real.close()
    }
  }
  const chunks = []
  tail.on('data', (chunk) => { chunks.push(chunk) })
  await tail._readRemainderFromFileHandle()
  t.same(Buffer.concat(chunks), Buffer.from('AAA'), 'no zero padding at EOF')
  t.same(requests, [
    {size: 257, length: 257, position: 0}
  , {size: 257, length: 257, position: 3}
  ])
  t.equal(closed, 1)
})

test('Partial read failure closes the old handle and resumes replacement', async (t) => {
  const {tail, filename, symbols} = await setup(t)
  await rotate(filename, Buffer.alloc(4096, 65), Buffer.from('next'))
  const handle = tail[symbols.fileHandle]
  const read = handle.read.bind(handle)
  let count = 0
  handle.read = async (...args) => {
    if (++count === 2) throw Object.assign(new Error('synthetic failure'), {code: 'EIO'})
    return read(...args)
  }
  const chunks = []
  const errors = []
  tail.on('data', (chunk) => { chunks.push(chunk) })
  tail.on('tail_error', (err) => { errors.push(err) })
  await tail._pollFileForChanges()
  const expected = Buffer.concat([Buffer.alloc(1024, 65), Buffer.from('next')])
  t.same(Buffer.concat(chunks), expected)
  t.equal(errors.length, 1)
  t.equal(errors[0].meta.code, 'EIO')
  t.equal(handle.fd, -1)
})

test('Graceful quit cannot overtake a paused rotation remainder', async (t) => {
  const {tail, filename, symbols} = await setup(t)
  const bytes = Buffer.alloc(8192, 97)
  const next = Buffer.from('new')
  await rotate(filename, bytes, next)
  const polling = tail._pollFileForChanges()
  await waitFor(() => { return tail[symbols.demand] })
  let settled = false
  const quitting = tail.quit().then(() => { settled = true })
  await immediate()
  t.notOk(settled, 'quit waits for continued consumption')
  const chunks = []
  tail.on('data', (chunk) => { chunks.push(chunk) })
  await quitting
  await polling
  t.same(Buffer.concat(chunks), Buffer.concat([bytes, next]))
})

for (const missing of [false, true]) {
  for (const fail of [false, true]) {
    test(`End during remainder IO; missing=${missing}, fail=${fail}`, async (t) => {
      const {tail, filename, symbols} = await setup(t)
      await rotate(filename, Buffer.from('unread'))
      if (missing) await fs.promises.unlink(filename)
      const handle = tail[symbols.fileHandle]
      const stat = handle.stat.bind(handle)
      handle.stat = async () => {
        const result = await stat()
        tail.destroy()
        if (fail) throw new Error('IO failed during termination')
        return result
      }
      await tail._pollFileForChanges()
      t.equal(handle.fd, -1, 'old handle closed')
      t.equal(tail[symbols.fileHandle], null, 'replacement not opened after termination')
      t.equal(tail.listenerCount('end'), 0, 'drain listener removed')
    })
  }
}

test('Destroy wakes a paused remainder and closes its handle', async (t) => {
  const {tail, filename, symbols} = await setup(t)
  await rotate(filename, Buffer.alloc(8192))
  const handle = tail[symbols.fileHandle]
  const polling = tail._pollFileForChanges()
  await waitFor(() => { return tail[symbols.demand] })
  const closed = once(tail, 'close')
  tail.destroy()
  await closed
  // Destruction completes only after the drain closes its old handle.
  await polling
  t.equal(handle.fd, -1)
  t.equal(tail[symbols.demand], null)
})

test('Legacy error quit wakes a paused remainder and still emits end', async (t) => {
  const {tail, filename, symbols} = await setup(t)
  await rotate(filename, Buffer.alloc(8192))
  const handle = tail[symbols.fileHandle]
  const polling = tail._pollFileForChanges()
  await waitFor(() => { return tail[symbols.demand] })
  const events = []
  tail.on('error', () => { events.push('error') })
  tail.on('end', () => { events.push('end') })
  await tail.quit(new Error('synthetic failure'))
  await polling
  t.same(events, ['error', 'end'])
  t.equal(handle.fd, -1)
})

test('Termination after a read suppresses the pending chunk', async (t) => {
  const {tail, filename, symbols} = await setup(t)
  await rotate(filename, Buffer.from('unread'))
  const handle = tail[symbols.fileHandle]
  const read = handle.read.bind(handle)
  handle.read = async (...args) => {
    const result = await read(...args)
    tail.destroy()
    await immediate()
    return result
  }
  let emitted = 0
  tail.on('data', () => { emitted++ })
  await tail._pollFileForChanges()
  t.equal(emitted, 0)
  t.equal(handle.fd, -1)
  t.equal(tail.listenerCount('close'), 0, 'scoped listener removed')
})

for (const highWaterMark of [0, 7]) {
  test(`Rotation bound with outer watermark ${highWaterMark}`, async (t) => {
    const {tail, filename, symbols} = await setup(t, {highWaterMark})
    const expected = Buffer.alloc(130000, 65)
    await rotate(filename, expected, Buffer.alloc(0))
    const handle = tail[symbols.fileHandle]
    const read = handle.read.bind(handle)
    const sizes = []
    handle.read = async (...args) => {
      sizes.push(args[0].length)
      return read(...args)
    }
    const chunks = []
    tail.on('data', (chunk) => { chunks.push(chunk) })
    await tail._pollFileForChanges()
    t.same(Buffer.concat(chunks), expected)
    t.equal(sizes[0], highWaterMark || 65536)
    t.ok(sizes.every((size) => { return size <= (highWaterMark || 65536) }))
  })
}

test('Slow writable repeatedly backpressures rotated reads', async (t) => {
  const {tail, filename} = await setup(t)
  const bytes = Buffer.from('€😀\n'.repeat(2048))
  await rotate(filename, bytes, Buffer.from('next'))
  const chunks = []
  let pauses = 0
  const output = new Writable({
    highWaterMark: 1
  , write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk))
      setImmediate(callback)
    }
  })
  tail.on('pause', () => { pauses++ })
  tail.pipe(output)
  const finished = once(output, 'finish')
  const polling = tail._pollFileForChanges()
  await tail.quit()
  await polling
  await finished
  t.same(Buffer.concat(chunks), Buffer.concat([bytes, Buffer.from('next')]))
  t.ok(pauses > 1)
})

test('Inner latin1 reads retain upstream byte-position behavior', async (t) => {
  const {tail, filename, symbols} = await setup(t, {
    readStreamOpts: {encoding: 'latin1'}
  })
  const chunks = []
  let truncated = 0
  tail.on('data', (chunk) => { chunks.push(chunk) })
  tail.on('truncated', () => { truncated++ })
  await fs.promises.appendFile(filename, Buffer.from([0xe9]))
  await tail._pollFileForChanges()
  await tail._pollFileForChanges()
  t.equal(tail[symbols.startPos], 1)
  t.equal(chunks.length, 1, 'unchanged content is not replayed')
  t.equal(truncated, 0)
})

test('Outer UTF-8 decoding handles one-byte rotation reads', async (t) => {
  const {tail, filename} = await setup(t, {highWaterMark: 1, encoding: 'utf8'})
  const chunks = []
  tail.on('data', (chunk) => { chunks.push(chunk) })
  await rotate(filename, Buffer.from('€😀'), Buffer.from('終'))
  await tail._pollFileForChanges()
  t.equal(chunks.join(''), '€😀終')
})

for (const sync of [false, true]) {
  test(`Numbered rotation writer; synchronous=${sync}`, async (t) => {
    const {tail, filename} = await setup(t)
    const chunks = []
    tail.on('data', (chunk) => { chunks.push(chunk) })
    const expected = []
    for (let i = 0; i < 4; i++) {
      const bytes = Buffer.from(`record ${i}: €😀\n`)
      expected.push(bytes)
      if (sync) {
        const fd = fs.openSync(filename, 'a')
        fs.writeSync(fd, bytes)
        fs.closeSync(fd)
        if (fs.existsSync(`${filename}.2`)) fs.unlinkSync(`${filename}.2`)
        if (fs.existsSync(`${filename}.1`)) fs.renameSync(`${filename}.1`, `${filename}.2`)
        fs.renameSync(filename, `${filename}.1`)
        fs.writeFileSync(filename, '')
      } else {
        const handle = await fs.promises.open(filename, 'a')
        await handle.write(bytes)
        await handle.close()
        if (i > 1) await fs.promises.unlink(`${filename}.2`)
        if (i > 0) await fs.promises.rename(`${filename}.1`, `${filename}.2`)
        await fs.promises.rename(filename, `${filename}.1`)
        await fs.promises.writeFile(filename, '')
      }
      await tail._pollFileForChanges()
    }
    t.same(Buffer.concat(chunks), Buffer.concat(expected))
  })
}
