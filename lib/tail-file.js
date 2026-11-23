'use strict'

const {Readable} = require('stream')
const fs = require('fs')

const DEFAULT_READ_SIZE = 64 * 1024

const kOpts = Symbol('opts')
const kFileName = Symbol('filename')
const kPollFileIntervalMs = Symbol('pollFileIntervalMs')
const kPollFailureRetryMs = Symbol('pollFailureRetryMs')
const kMaxPollFailures = Symbol('maxPollFailures')
const kPollFailureCount = Symbol('pollFailureCount')
const kStartPos = Symbol('startPos')
const kStream = Symbol('stream')
const kFileHandle = Symbol('fileHandle')
const kPollTimer = Symbol('pollTimer')
const kQuitting = Symbol('quitting')
const kInode = Symbol('inode')
const kPolling = Symbol('polling')
const kDemand = Symbol('demand')
const kOpening = Symbol('opening')
const kStarting = Symbol('starting')
const kReady = Symbol('ready')
const kQuit = Symbol('quit')
const kCleanup = Symbol('cleanup')
const kEnding = Symbol('ending')
const kCompleted = Symbol('completed')
const kCancellation = Symbol('cancellation')

function NOOP() {}

function abortError() {
  const error = new Error('Tailing was cancelled')
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

function stopped(tail) {
  return tail.destroyed || tail[kEnding]
}

function borrowedSource(opts) {
  if (opts.fd === undefined || opts.fd === null || opts.autoClose !== false) return opts
  // Node rejects a FileHandle fd combined with custom fs; keep its error.
  if (typeof opts.fd !== 'number' && opts.fs) return opts
  // Leave unsupported descriptors and read implementations to Node's validation.
  if (typeof opts.fd !== 'number' && typeof opts.fd.close !== 'function') return opts
  const implementation = opts.fs || fs
  if (typeof implementation.read !== 'function') return opts
  const source = {
    ...opts
  , fs: {
      read: implementation.read.bind(implementation)
    , close: (fd, callback) => { callback() }
    }
  }
  if (typeof opts.fd !== 'number') source.fd = opts.fd.fd
  return source
}

class TailFile extends Readable {
  constructor(filename, opts) {
    opts = opts || {}

    const {
      pollFileIntervalMs
    , pollFailureRetryMs
    , maxPollFailures
    , readStreamOpts
    , startPos
    , ...superOpts
    } = opts

    if (typeof filename !== 'string' || !filename.length) {
      const err = new TypeError('filename must be a non-empty string')
      err.code = 'EFILENAME'
      throw err
    }
    if (pollFileIntervalMs && typeof pollFileIntervalMs !== 'number') {
      const err = new TypeError('pollFileIntervalMs must be a number')
      err.code = 'EPOLLINTERVAL'
      err.meta = {
        got: pollFileIntervalMs
      }
      throw err
    }
    if (pollFailureRetryMs && typeof pollFailureRetryMs !== 'number') {
      const err = new TypeError('pollFailureRetryMs must be a number')
      err.code = 'EPOLLRETRY'
      err.meta = {
        got: pollFailureRetryMs
      }
      throw err
    }
    if (maxPollFailures && typeof maxPollFailures !== 'number') {
      const err = new TypeError('maxPollFailures must be a number')
      err.code = 'EMAXPOLLFAIL'
      err.meta = {
        got: maxPollFailures
      }
      throw err
    }
    if (readStreamOpts && typeof readStreamOpts !== 'object') {
      const err = new TypeError('readStreamOpts must be an object')
      err.code = 'EREADSTREAMOPTS'
      err.meta = {
        got: typeof readStreamOpts
      }
      throw err
    }
    if (startPos !== null && startPos !== undefined) {
      if (typeof startPos !== 'number') {
        const err = new TypeError('startPos must be an integer >= 0')
        err.code = 'ESTARTPOS'
        err.meta = {
          got: typeof startPos
        }
        throw err
      }
      if (startPos < 0 || !Number.isInteger(startPos)) {
        const err = new RangeError('startPos must be an integer >= 0')
        err.code = 'ESTARTPOS'
        err.meta = {
          got: startPos
        }
        throw err
      }
    }

    super(superOpts)

    this[kOpts] = opts
    this[kFileName] = filename
    this[kPollFileIntervalMs] = pollFileIntervalMs || 1000
    this[kPollFailureRetryMs] = pollFailureRetryMs || 200
    this[kMaxPollFailures] = maxPollFailures || 10
    this[kPollFailureCount] = 0
    this[kStartPos] = startPos >= 0
      ? startPos
      : null
    this[kStream] = null
    this[kFileHandle] = null
    this[kPollTimer] = null
    this[kQuitting] = false
    this[kInode] = null
    this[kPolling] = null
    this[kDemand] = null
    this[kOpening] = null
    this[kStarting] = null
    this[kReady] = null
    this[kQuit] = null
    this[kCleanup] = null
    this[kEnding] = false
    this[kCompleted] = false
    this[kCancellation] = null
  }

  start() {
    if (!this[kStarting]) {
      this[kStarting] = this._start().catch((error) => {
        if (!stopped(this)) this[kStarting] = null
        throw error
      })
    }
    return this[kStarting]
  }

  async _start() {
    if (stopped(this)) throw this[kCancellation] || abortError()
    try {
      await this._openFile()
    } catch (error) {
      throw this[kCancellation] || error
    }
    if (stopped(this)) throw this[kCancellation] || abortError()
    // A paused initial read must not block `await start(); attachConsumer()`.
    const ready = new Promise((resolve) => { this[kReady] = resolve })
    try {
      await Promise.race([this._pollFileForChanges(), ready])
      if (this[kCancellation]) throw this[kCancellation]
    } finally {
      this[kReady] = null
    }
    return
  }

  _openFile() {
    this[kOpening] = this._openFileHandle().finally(() => {
      this[kOpening] = null
    })
    return this[kOpening]
  }

  async _openFileHandle() {
    const handle = await fs.promises.open(this[kFileName], 'r')
    if (stopped(this)) {
      await handle.close().catch(NOOP)
      throw this[kCancellation] || abortError()
    }
    this[kFileHandle] = handle
    return
  }

  async _readRemainderFromFileHandle() {
    // Read the end of a renamed file before re-opening the new file.
    // Use the file handle since it remains open even if the file name has changed
    const fileHandleTemp = this[kFileHandle] // Prevent races when closing
    this[kFileHandle] = null
    const chunkSize = this.readableHighWaterMark || DEFAULT_READ_SIZE
    try {
      const stats = await fileHandleTemp.stat()
      while (this[kStartPos] < stats.size) {
        if (stopped(this)) break
        const length = Math.min(chunkSize, stats.size - this[kStartPos])
        const buffer = Buffer.alloc(length)
        const {bytesRead} = await fileHandleTemp.read(buffer, 0, length, this[kStartPos])
        if (stopped(this) || bytesRead === 0) break
        this[kStartPos] += bytesRead
        await this._pushChunk(buffer.subarray(0, bytesRead))
      }
    } finally {
      this[kDemand] = null
      await fileHandleTemp.close()
    }
    return
  }

  async _pushChunk(chunk) {
    // Register demand before push, which can synchronously call consumer code.
    const demand = new Promise((resolve) => {
      this[kDemand] = resolve
    })
    if (!this.push(chunk)) {
      if (this[kReady]) this[kReady]()
      await demand
    }
    this[kDemand] = null
  }

  async _readChunks(stream) {
    for await (const chunk of stream.iterator({destroyOnReturn: false})) {
      if (stopped(this)) break
      this[kStartPos] += chunk.length
      await this._pushChunk(chunk)
      if (stopped(this)) break
    }
    return
  }

  _pollFileForChanges() {
    if (stopped(this)) return Promise.resolve({})
    // Keep ownership through backpressure for ordinary and rotated reads alike.
    if (!this[kPolling]) {
      clearTimeout(this[kPollTimer])
      this[kPollTimer] = null
      this[kPolling] = this._pollFile().then((result) => {
        // Release read ownership before shutdown waits for active work.
        this[kPolling] = null
        if (result.error && result.fatal && !this[kQuitting] && !stopped(this)) {
          return this.quit(result.error).then(() => { return result })
        }
        return result
      }, (error) => {
        this[kPolling] = null
        throw error
      })
    }
    return this[kPolling]
  }

  async _pollFile() {
    try {
      const stats = await fs.promises.stat(this[kFileName], {bigint: true})
      if (stopped(this)) return {}

      this[kPollFailureCount] = 0 // reset
      const eof = Number(stats.size)
      let fileHasChanged = false

      if (this[kInode] === null) this[kInode] = stats.ino

      if (this[kStartPos] === null) {
        // First iteration - nothing has been polled yet
        this[kStartPos] = eof
      } else if (this[kInode] !== stats.ino) {
        // File renamed/rolled between polls without triggering `ENOENT`.
        // Conditional since this *may* have already been done if `ENOENT` threw earlier.
        if (this[kFileHandle]) {
          try {
            await this._readRemainderFromFileHandle()
          } catch (error) {
            if (stopped(this)) return {}
            const err = new Error('Could not read remaining bytes from old FH')
            err.meta = {
              error: error.message
            , code: error.code
            }
            this.emit('tail_error', err)
            if (this[kQuitting]) return {error}
          }
        }
        if (stopped(this)) return {}
        await this._openFile()
        if (stopped(this)) return {}
        this[kStartPos] = 0
        this[kInode] = stats.ino
        fileHasChanged = true
        this.emit('renamed', {
          message: 'The file was renamed or rolled.  Tailing resumed from the beginning.'
        , filename: this[kFileName]
        , when: new Date()
        })
      } else if (eof < this[kStartPos]) {
        // Same file, but smaller/truncated
        this[kStartPos] = 0
        this[kInode] = stats.ino
        fileHasChanged = true
        this.emit('truncated', {
          message: 'The file was truncated.  Tailing resumed from the beginning.'
        , filename: this[kFileName]
        , when: new Date()
        })
      } else if (this[kStartPos] !== eof) {
        fileHasChanged = true
      }

      if (fileHasChanged) {
        const error = await this._streamFileChanges()
        if (error) {
          this._scheduleTimer(this[kPollFileIntervalMs])
          return {error}
        }
      }
      if (stopped(this)) return {}
      const flush = this._queueFlush()
      this._scheduleTimer(this[kPollFileIntervalMs])
      return {flush}

    } catch (err) {
      if (stopped(this)) return {}
      if (err.code === 'ENOENT') {
        if (this[kFileHandle]) {
          // The .stat() via polling may have happened during a file rename/roll.
          // Don't lose the last lines in the file if it previously existed.
          // Perhaps it has not been re-created yet (or won't be)
          try {
            await this._readRemainderFromFileHandle()
          } catch (error) {
            if (stopped(this)) return {}
            this.emit('tail_error', error)
            if (this[kQuitting]) return {error}
          }
        }
        if (stopped(this)) return {}
        if (this[kQuitting]) return {flush: this._queueFlush()}
        this[kPollFailureCount]++
        if (this[kPollFailureCount] >= this[kMaxPollFailures]) {
          return {error: err, fatal: true}
        }
        this.emit('retry', {
          message: 'File disappeared. Retrying.'
        , filename: this[kFileName]
        , attempts: this[kPollFailureCount]
        , when: new Date()
        })
        this._scheduleTimer(this[kPollFailureRetryMs])
        return {}
      }
      // Some other error like EACCES
      // TODO: Retries for certain error codes can be put here
      return {error: err, fatal: true}
    }
  }

  _queueFlush() {
    const lastReadPosition = this[kStartPos]
    return new Promise((resolve) => {
      setImmediate(() => {
        if (!stopped(this)) this.emit('flush', {lastReadPosition})
        resolve()
      })
    })
  }

  _scheduleTimer(ms) {
    clearTimeout(this[kPollTimer])
    this[kPollTimer] = null
    if (this[kQuitting] || stopped(this)) return
    this[kPollTimer] = setTimeout(() => {
      this._pollFileForChanges().catch((error) => { this.destroy(error) })
    }, ms)
    return
  }

  async _streamFileChanges() {
    if (stopped(this)) return
    let stream
    let closed
    try {
      stream = fs.createReadStream(this[kFileName], borrowedSource({
        ...this[kOpts].readStreamOpts
      , start: this[kStartPos]
      , emitClose: true
      }))
      this[kStream] = stream
      // A pending read or close may fail after the iterator has returned.
      stream.once('error', NOOP)
      closed = new Promise((resolve) => { stream.once('close', resolve) })
      await this._readChunks(stream)
    } catch (err) {
      if (stopped(this)) return
      // Possible file removal.  Let auto-retry handle it.
      this[kPollFailureCount]++
      const error = new Error('An error was encountered while tailing the file')
      error.code = 'ETAIL'
      error.meta = {actual: err}
      // Emitting on 'error' would bork the parent Readstream
      this.emit('tail_error', error)
      return err
    } finally {
      if (stream) {
        stream.destroy()
        await closed
        this[kStream] = null
      }
    }
    return
  }

  _read() {
    if (this[kDemand]) {
      const resolve = this[kDemand]
      this[kDemand] = null
      resolve()
    }
    return
  }

  quit(err) {
    if (this[kQuit]) return this[kQuit]
    this[kQuitting] = true
    clearTimeout(this[kPollTimer])
    this[kPollTimer] = null
    // Install shared shutdown before error/flush listeners can reenter quit().
    this[kQuit] = Promise.resolve().then(() => { return this._quit(err) })
    return this[kQuit]
  }

  async _quit(err) {
    let failure
    let fatal = err
    if (!err && !this.destroyed) {
      try {
        if (this[kOpening]) await this[kOpening]
        // The active read and this final snapshot are distinct operations.
        const active = this[kPolling] ? await this[kPolling] : {}
        if (active.error) {
          failure = active.error
          fatal = active.fatal && failure
        } else if (!this.destroyed) {
          const result = await this._pollFileForChanges()
          failure = result.error
          fatal = result.fatal && failure
          if (result.flush) await result.flush
        }
      } catch (error) {
        failure = error
      }
    }
    this[kEnding] = true
    this._read()
    try {
      if (fatal && !this.destroyed) this.emit('error', fatal)
    } finally {
      await this._cleanup()
    }
    if (this[kCancellation]) throw this[kCancellation]

    this[kCompleted] = true
    this.push(null)
    await new Promise((resolve) => {
      process.nextTick(() => {
        if (!this.destroyed && !this._readableState.endEmitted) {
          // Retain the legacy end notification even when consumption is paused.
          this.emit('end')
        }
        resolve()
      })
    })
    if (failure) throw failure
    return
  }

  _cleanup() {
    if (!this[kCleanup]) this[kCleanup] = this._closeResources()
    return this[kCleanup]
  }

  async _closeResources() {
    if (this[kStream]) this[kStream].destroy()
    if (this[kOpening]) await this[kOpening].catch(NOOP)
    if (this[kPolling]) await this[kPolling].catch(NOOP)
    if (this[kFileHandle]) {
      const handle = this[kFileHandle]
      this[kFileHandle] = null
      await handle.close().catch(NOOP)
    }
    return
  }

  _destroy(error, callback) {
    if (!this[kCompleted]) this[kCancellation] = error || abortError()
    this[kQuitting] = true
    clearTimeout(this[kPollTimer])
    this[kPollTimer] = null
    this._read()
    this._cleanup().then(() => { callback(error) }, callback)
    return
  }
}

module.exports = TailFile
