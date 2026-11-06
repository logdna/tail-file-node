'use strict'

const fs = require('fs')
const path = require('path')
const {once} = require('events')
const {Readable, Writable} = require('stream')
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
  , readStreamOpts: {highWaterMark: 1024}
  , ...opts
  })
  const symbols = getSymbols(tail)
  await tail.start()
  clearTimeout(tail[symbols.pollTimer])
  t.teardown(async () => {
    if (!tail.closed) {
      const closed = once(tail, 'close')
      tail.destroy()
      await closed
    }
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
  let closed = 0
  const close = handle.close.bind(handle)
  handle.close = async () => {
    closed++
    return close()
  }
  handle.read = async (buffer, offset, length, position) => {
    requests.push({allocation: buffer.length, length, position})
    // Force short reads that split multibyte characters.
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
  await tail._pollFileForChanges()
  await waitFor(() => { return tail[symbols.demand] })
  const count = requests.length
  await immediate()
  t.equal(requests.length, count, 'no reads while backpressured')
  t.ok(count < 10, 'pauses after a bounded prefix')
  t.equal(closed, 0, 'old handle stays open while paused')
  const chunks = []
  tail.on('data', (chunk) => { return chunks.push(chunk) })
  await tail[symbols.polling]
  Buffer.alloc = alloc
  t.same(Buffer.concat(chunks), Buffer.concat([oldBytes, next]), 'exact ordered bytes')
  t.ok(chunks.every((chunk) => { return chunk.length <= 1024 }), 'bounded emitted chunks')
  t.ok(allocations.every((size) => { return size <= 1024 }), 'no oversized allocation')
  t.ok(
    requests.every((req) => { return req.allocation <= 1024 && req.length <= 1024 }),
    'bounded buffers and read requests'
  )
  t.equal(requests[1].position, 317, 'advances by actual bytes read')
  t.equal(closed, 1, 'closes old handle exactly once')
  await tail.quit()
  t.equal(tail[symbols.fileHandle], null, 'graceful exit closes replacement handle')
})

test('Large stat size and early EOF use bounded buffers without padding', async (t) => {
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
  tail.on('data', (chunk) => { return chunks.push(chunk) })
  await tail._readRemainderFromFileHandle()
  t.same(Buffer.concat(chunks), Buffer.from('AAA'), 'only actual bytes emitted')
  t.same(requests, [
    {size: 257, length: 257, position: 0}
  , {size: 257, length: 257, position: 3}
  ], 'bounded requests even with a synthetic 1 GiB remainder')
  t.equal(closed, 1, 'EOF closes the handle')
})

test('Partial read failure closes old handle and resumes replacement', async (t) => {
  const {tail, filename, symbols} = await setup(t)
  await rotate(filename, Buffer.alloc(4096, 65), Buffer.from('next'))
  const handle = tail[symbols.fileHandle]
  const read = handle.read.bind(handle)
  let count = 0
  handle.read = async (...args) => {
    if (++count === 2) {
      throw Object.assign(new Error('synthetic read failure'), {code: 'EIO'})
    }
    return read(...args)
  }
  const chunks = []
  const errors = []
  tail.on('data', (chunk) => { return chunks.push(chunk) })
  tail.on('tail_error', (err) => { return errors.push(err) })
  await tail._pollFileForChanges()
  await tail[symbols.polling]
  const expected = Buffer.concat([Buffer.alloc(1024, 65), Buffer.from('next')])
  t.same(Buffer.concat(chunks), expected)
  t.equal(errors.length, 1, 'one recoverable error')
  t.equal(errors[0].meta.code, 'EIO', 'preserves error code')
  t.equal(handle.fd, -1, 'failed old descriptor is closed')
})

for (const rotation of [false, true]) {
  test(`Graceful quit waits for consumption; rotation=${rotation}`, async (t) => {
    const {tail, filename, symbols} = await setup(t)
    const bytes = Buffer.alloc(8192, 97)
    if (rotation) await rotate(filename, bytes, Buffer.from('new'))
    else await fs.promises.appendFile(filename, bytes)
    await tail._pollFileForChanges()
    await waitFor(() => { return tail[symbols.demand] })
    const polling = tail[symbols.polling]
    await tail._pollFileForChanges()
    t.equal(tail[symbols.polling], polling, 'a second poll shares the active operation')
    let settled = false
    const quitting = tail.quit().then(() => {
      settled = true
    })
    t.equal(tail.quit(), tail[symbols.quit], 'repeated quit shares the same operation')
    await immediate()
    t.notOk(settled, 'graceful shutdown remains pending while paused')
    t.equal(tail[symbols.polling], polling, 'shutdown does not start a competing poll')
    const chunks = []
    tail.on('data', (chunk) => { return chunks.push(chunk) })
    await quitting
    const expected = rotation ? Buffer.concat([bytes, Buffer.from('new')]) : bytes
    t.same(Buffer.concat(chunks), expected)
    t.equal(tail[symbols.fileHandle], null, 'handle closed before quit resolves')
    t.equal(tail[symbols.pollTimer], null, 'no timer after graceful quit')
  })

  test(`Destroy cancels backpressured shutdown; rotation=${rotation}`, async (t) => {
    const {tail, filename, symbols} = await setup(t)
    if (rotation) await rotate(filename, Buffer.alloc(8192))
    else await fs.promises.appendFile(filename, Buffer.alloc(8192))
    const old = tail[symbols.fileHandle]
    await tail._pollFileForChanges()
    await waitFor(() => { return tail[symbols.demand] })
    const quitting = tail.quit()
    const source = tail[symbols.stream]
    const closed = once(tail, 'close')
    tail.destroy()
    await closed
    await quitting
    t.equal(old.fd, -1, 'original descriptor closed')
    t.equal(tail[symbols.fileHandle], null, 'no replacement descriptor opened')
    t.equal(tail[symbols.stream], null, 'no active stream')
    if (source) t.equal(source.fd, null, 'ordinary read descriptor closed before close')
    t.equal(tail[symbols.pollTimer], null, 'no polling timer')
    let emissions = 0
    tail.on('data', () => { return emissions++ })
    tail.on('renamed', () => { return emissions++ })
    tail.on('flush', () => { return emissions++ })
    await immediate()
    t.equal(emissions, 0, 'no data or polling events after close')
  })
}

test('Destroy waits for a rotated read and suppresses its result', async (t) => {
  const {tail, filename, symbols} = await setup(t)
  await rotate(filename, Buffer.alloc(4096))
  const handle = tail[symbols.fileHandle]
  const read = handle.read.bind(handle)
  let release
  let entered = false
  handle.read = async (...args) => {
    entered = true
    await new Promise((resolve) => {
      release = resolve
    })
    return read(...args)
  }
  const polling = tail._pollFileForChanges()
  await waitFor(() => { return entered })
  let emitted = 0
  tail.on('data', () => { return emitted++ })
  const closed = once(tail, 'close')
  tail.destroy()
  t.notOk(tail.closed, 'cleanup waits for pending IO')
  release()
  await closed
  await polling
  t.equal(emitted, 0, 'does not push the pending read after destruction')
  t.equal(handle.fd, -1, 'descriptor closed after read completes')
})

for (const sync of [false, true]) {
  test(`Synthetic numbered rotation writer; synchronous=${sync}`, async (t) => {
    const {tail, filename, symbols} = await setup(t)
    const chunks = []
    tail.on('data', (chunk) => { return chunks.push(chunk) })
    const expected = []
    for (let i = 0; i < 4; i++) {
      const bytes = Buffer.from(`record ${i}: €😀\n`)
      expected.push(bytes)
      // Both writers close the active file before shifting numbered archives.
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
      // Observe each rotation; archive replay is deliberately outside the contract.
      await tail._pollFileForChanges()
      await tail[symbols.polling]
    }
    t.same(Buffer.concat(chunks), Buffer.concat(expected), 'paced rotations stay ordered')
  })
}

test('Destroyed instances ignore start, poll, open and pending chunks', async (t) => {
  const {tail} = await setup(t)
  const closed = once(tail, 'close')
  tail.destroy()
  await closed
  await tail.start()
  await tail._openFile()
  await tail._pollFileForChanges()
  await tail._pushChunk(Buffer.from('ignored'))
  await tail._flush()
  const stream = Readable.from([Buffer.from('late chunk')])
  await tail._readChunks(stream)
  t.equal(tail.readableLength, 0, 'no late data buffered')
  t.ok(stream.destroyed, 'late source destroyed')
})

test('Destroy from a data callback cannot leave a backpressure waiter', async (t) => {
  const {tail, symbols} = await setup(t)
  const push = tail.push.bind(tail)
  tail.push = (chunk) => {
    push(chunk)
    tail.destroy()
    return false
  }
  const closed = once(tail, 'close')
  await tail._pushChunk(Buffer.alloc(1024))
  await closed
  t.equal(tail[symbols.demand], null, 'no waiter installed after destruction')
})

test('Direct backpressure waiter resumes without an active poll', async (t) => {
  const {tail, symbols} = await setup(t)
  const pushed = tail._pushChunk(Buffer.alloc(1024))
  t.type(tail[symbols.demand], 'function')
  tail.resume()
  await pushed
  t.equal(tail[symbols.demand], null)
})

for (const fail of [false, true]) {
  test(`Destroy during pathname stat; failure=${fail}`, async (t) => {
    const {tail, filename} = await setup(t)
    const stat = fs.promises.stat
    t.teardown(() => {
      fs.promises.stat = stat
    })
    fs.promises.stat = async (...args) => {
      const result = await stat(...args)
      tail.destroy()
      if (fail) throw new Error('stat failed during cancellation')
      return result
    }
    const closed = once(tail, 'close')
    await tail._pollFileForChanges()
    await closed
    t.ok(tail.closed, `cancelled stat of ${path.basename(filename)}`)
  })
}

for (const missing of [false, true]) {
  for (const fail of [false, true]) {
    test(`Destroy during remainder stat; missing=${missing}, fail=${fail}`, async (t) => {
      const {tail, filename, symbols} = await setup(t)
      await rotate(filename, Buffer.from('unread'))
      if (missing) await fs.promises.unlink(filename)
      const handle = tail[symbols.fileHandle]
      const stat = handle.stat.bind(handle)
      handle.stat = async () => {
        const result = await stat()
        tail.destroy()
        if (fail) throw new Error('stat failed during cancellation')
        return result
      }
      const closed = once(tail, 'close')
      await tail._pollFileForChanges()
      await closed
      t.equal(handle.fd, -1, 'remainder handle closed')
    })
  }
}

for (const initial of [false, true]) {
  test(`Destroy during file open; initial=${initial}`, async (t) => {
    let tail
    let filename
    let operation
    if (initial) {
      filename = path.join(t.testdir({'active.log': ''}), 'active.log')
      tail = new TailFile(filename)
      operation = () => { return tail.start() }
    } else {
      const setupResult = await setup(t)
      tail = setupResult.tail
      filename = setupResult.filename
      await rotate(filename, Buffer.from('unread'))
      operation = () => { return tail._pollFileForChanges() }
    }
    const open = fs.promises.open
    let opened
    t.teardown(() => {
      fs.promises.open = open
    })
    fs.promises.open = async (...args) => {
      opened = await open(...args)
      tail.destroy()
      return opened
    }
    const closed = once(tail, 'close')
    await operation()
    await closed
    t.equal(opened.fd, -1, 'new descriptor closed before close event')
  })
}

test('Error shutdown cancels reads and closes the descriptor', async (t) => {
  const {tail, symbols} = await setup(t)
  const handle = tail[symbols.fileHandle]
  const err = new Error('stop now')
  let received
  tail.on('error', (error) => {
    received = error
  })
  const closed = new Promise((resolve) => {
    tail.once('close', resolve)
  })
  await tail.quit(err)
  await closed
  t.equal(received, err)
  t.equal(handle.fd, -1)
})

test('Destroy during the final graceful poll settles quit', async (t) => {
  const {tail} = await setup(t)
  const stat = fs.promises.stat
  t.teardown(() => {
    fs.promises.stat = stat
  })
  fs.promises.stat = async (...args) => {
    const result = await stat(...args)
    tail.destroy()
    return result
  }
  const closed = once(tail, 'close')
  await tail.quit()
  await closed
  await tail.start()
  t.ok(tail.closed)
})

for (const opts of [
  {highWaterMark: 0}
, {readStreamOpts: {highWaterMark: 0}}
, {highWaterMark: 7, readStreamOpts: {highWaterMark: 3}}
]) {
  test(`Rotation read bound with ${JSON.stringify(opts)}`, async (t) => {
    const {tail, filename, symbols} = await setup(t, opts)
    await rotate(filename, Buffer.from('abcdefghij'), Buffer.alloc(0))
    const handle = tail[symbols.fileHandle]
    const read = handle.read.bind(handle)
    const sizes = []
    handle.read = async (...args) => {
      sizes.push(args[0].length)
      return read(...args)
    }
    const chunks = []
    tail.on('data', (chunk) => { return chunks.push(chunk) })
    await tail._readRemainderFromFileHandle()
    t.same(Buffer.concat(chunks), Buffer.from('abcdefghij'))
    t.ok(sizes.every((size) => { return size <= (opts.highWaterMark === 7 ? 3 : 1) }))
  })
}

test('Slow writable applies backpressure without overlapping reads', async (t) => {
  const {tail, filename, symbols} = await setup(t)
  const bytes = Buffer.from('€😀\n'.repeat(2048))
  await rotate(filename, bytes, Buffer.from('next'))
  const handle = tail[symbols.fileHandle]
  const read = handle.read.bind(handle)
  let active = 0
  let maxActive = 0
  let pauses = 0
  handle.read = async (...args) => {
    maxActive = Math.max(maxActive, ++active)
    await immediate()
    try {
      return await read(...args)
    } finally {
      active--
    }
  }
  const chunks = []
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
  await tail._pollFileForChanges()
  await tail.quit()
  await finished
  t.same(Buffer.concat(chunks), Buffer.concat([bytes, Buffer.from('next')]))
  t.equal(maxActive, 1, 'one descriptor read at a time')
  t.ok(pauses > 1, 'consumer backpressured multiple chunks')
})

test('Rotation while an ordinary read is paused during graceful quit', async (t) => {
  const {tail, filename, symbols} = await setup(t)
  const first = Buffer.alloc(8192, 65)
  const last = Buffer.from('old file tail €😀')
  const replacement = Buffer.from('replacement €😀')
  await fs.promises.appendFile(filename, first)
  await tail._pollFileForChanges()
  await rotate(filename, last, replacement)
  const quitting = tail.quit()
  const chunks = []
  tail.on('data', (chunk) => { return chunks.push(chunk) })
  await quitting
  t.same(Buffer.concat(chunks), Buffer.concat([first, last, replacement]))
  t.equal(tail[symbols.fileHandle], null)
})
