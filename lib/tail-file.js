'use strict'

const {Readable} = require('stream')
const fs = require('fs')

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
const kOpening = Symbol('opening')
const kDemand = Symbol('demand')
const kQuit = Symbol('quit')
const kPollResult = Symbol('pollResult')
const kPaused = Symbol('paused')

function NOOP() {}

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
    this[kOpening] = null
    this[kDemand] = null
    this[kQuit] = null
    this[kPollResult] = null
    this[kPaused] = null
  }

  async start() {
    if (this.destroyed || this[kQuitting]) return
    await this._openFile()
    await this._pollFileForChanges()
    return
  }

  _openFile() {
    if (this.destroyed) return Promise.resolve()
    this[kOpening] = (async () => {
      const handle = await fs.promises.open(this[kFileName], 'r')
      if (this.destroyed) {
        await handle.close()
      } else {
        this[kFileHandle] = handle
      }
    })()
    return this[kOpening]
  }

  async _readRemainderFromFileHandle() {
    // Read the end of a renamed file before re-opening the new file.
    // Use the file handle since it remains open even if the file name has changed
    const fileHandleTemp = this[kFileHandle] // Prevent races when closing
    this[kFileHandle] = null
    // Bound allocations and read requests by the same options as ordinary reads.
    // Never reuse a buffer after push(): the consumer may retain it.
    const readOpts = this[kOpts].readStreamOpts || {}
    const readSize = readOpts.highWaterMark === undefined
      ? 64 * 1024
      : readOpts.highWaterMark
    const chunkSize = Math.max(1, Math.min(
      this.readableHighWaterMark
    , readSize
    ))
    try {
      const stats = await fileHandleTemp.stat()
      while (!this.destroyed && this[kStartPos] < stats.size) {
        const length = Math.min(chunkSize, stats.size - this[kStartPos])
        const buffer = Buffer.alloc(length)
        const {bytesRead} = await fileHandleTemp.read(buffer, 0, length, this[kStartPos])
        if (this.destroyed || bytesRead === 0) break
        this[kStartPos] += bytesRead
        await this._pushChunk(buffer.subarray(0, bytesRead))
      }
    } finally {
      await fileHandleTemp.close()
    }
    return
  }

  async _readChunks(stream) {
    // For node 16 and higher: https://nodejs.org/docs/latest-v16.x/api/stream.html#readableiteratoroptions
    /* istanbul ignore next */
    const iterator = stream.iterator
      ? stream.iterator({destroyOnReturn: false})
      : stream

    this[kStream] = stream
    try {
      for await (const chunk of iterator) {
        if (this.destroyed) return
        this[kStartPos] += Buffer.byteLength(chunk)
        await this._pushChunk(chunk)
      }
    } finally {
      stream.destroy()
      this[kStream] = null
    }
    await this._flush()
    return
  }

  async _pushChunk(chunk) {
    if (this.destroyed) return
    if (!this.push(chunk)) {
      if (this.destroyed) return
      this[kPollTimer] = null
      if (this[kPaused]) this[kPaused]()
      await new Promise((resolve) => {
        this[kDemand] = resolve
      })
    }
  }

  _flush() {
    const lastReadPosition = this[kStartPos]
    return new Promise((resolve) => {
      setImmediate(() => {
        if (!this.destroyed) this.emit('flush', {lastReadPosition})
        resolve()
      })
    })
  }

  _pollFileForChanges() {
    if (this.destroyed) return Promise.resolve()
    if (!this[kPolling]) {
      clearTimeout(this[kPollTimer])
      this[kPollTimer] = null
      this[kPolling] = this._pollFile().finally(() => {
        this[kPolling] = null
        this[kPaused] = null
      })
      // Keep start() responsive when the first read encounters backpressure.
      this[kPollResult] = Promise.race([
        this[kPolling]
      , new Promise((resolve) => {
          this[kPaused] = resolve
        })
      ])
    }
    return this[kPollResult]
  }

  async _pollFile() {
    try {
      const stats = await fs.promises.stat(this[kFileName])
      if (this.destroyed) return

      this[kPollFailureCount] = 0 // reset
      const eof = stats.size
      let fileHasChanged = false

      if (!this[kInode]) this[kInode] = stats.ino

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
            if (this.destroyed) return
            const err = new Error('Could not read remaining bytes from old FH')
            err.meta = {
              error: error.message
            , code: error.code
            }
            this.emit('tail_error', err)
          }
        }
        if (this.destroyed) return
        await this._openFile()
        if (this.destroyed) return
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
        await this._streamFileChanges()
      } else {
        await this._flush()
      }

      this._scheduleTimer(this[kPollFileIntervalMs])

    } catch (err) {
      if (this.destroyed) return
      if (err.code === 'ENOENT') {
        if (this[kFileHandle]) {
          // The .stat() via polling may have happened during a file rename/roll.
          // Don't lose the last lines in the file if it previously existed.
          // Perhaps it has not been re-created yet (or won't be)
          try {
            await this._readRemainderFromFileHandle()
          } catch (error) {
            if (this.destroyed) return
            this.emit('tail_error', error)
          }
        }
        if (this.destroyed) return
        this[kPollFailureCount]++
        if (this[kPollFailureCount] >= this[kMaxPollFailures]) {
          this.destroy(err)
          return
        }
        this.emit('retry', {
          message: 'File disappeared. Retrying.'
        , filename: this[kFileName]
        , attempts: this[kPollFailureCount]
        , when: new Date()
        })
        this._scheduleTimer(this[kPollFailureRetryMs])
        return
      }
      // Some other error like EACCES
      // TODO: Retries for certain error codes can be put here
      this.destroy(err)
    }
    return
  }

  _scheduleTimer(ms) {
    clearTimeout(this[kPollTimer])
    if (this[kQuitting] || this.destroyed) return
    this[kPollTimer] = setTimeout(this._pollFileForChanges.bind(this), ms)
    return
  }

  async _streamFileChanges() {
    try {
      const stream = fs.createReadStream(this[kFileName], {
        ...this[kOpts].readStreamOpts
      , start: this[kStartPos]
      })
      stream.setMaxListeners(100) // Allow for additional listeners when reading backpressured chunks
      await this._readChunks(stream)
    } catch (err) {
      if (this.destroyed) return
      // Possible file removal.  Let auto-retry handle it.
      this[kPollFailureCount]++
      const error = new Error('An error was encountered while tailing the file')
      error.code = 'ETAIL'
      error.meta = {actual: err}
      // Emitting on 'error' would bork the parent Readstream
      this.emit('tail_error', error)
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

  _destroy(err, callback) {
    this[kQuitting] = true
    clearTimeout(this[kPollTimer])
    this[kPollTimer] = null
    this._read()
    if (this[kStream]) this[kStream].destroy()
    // Pending filesystem operations settle before their handles can be closed.
    Promise.allSettled([this[kOpening], this[kPolling], this[kQuit]]).then(async () => {
      const handle = this[kFileHandle]
      this[kFileHandle] = null
      if (handle) await handle.close().catch(NOOP)
    }).then(() => {
      callback(err)
    }, callback)
  }

  quit(err) {
    if (err) {
      this.destroy(err)
      return Promise.resolve()
    }
    if (this[kQuit]) return this[kQuit]
    this[kQuitting] = true
    clearTimeout(this[kPollTimer])
    this[kPollTimer] = null
    this[kQuit] = this._quit()
    return this[kQuit]
  }

  async _quit() {
    // Drain the current read before polling once more. A paused consumer must
    // resume for graceful shutdown; destroy() is the abortive alternative.
    await Promise.allSettled([this[kOpening]])
    await this[kPolling]
    if (this.destroyed) return
    await this._pollFileForChanges()
    await this[kPolling]
    if (this.destroyed) return
    if (this[kFileHandle]) {
      const handle = this[kFileHandle]
      this[kFileHandle] = null
      await handle.close().catch(NOOP)
    }
    if (this[kStream]) this[kStream].destroy()
    this.push(null)

    process.nextTick(() => {
      if (!this.destroyed && this._readableState && !this._readableState.endEmitted) {
        // 'end' is not emitted unless data is flowing, but this makes
        // confusing inconsistencies, so emit it all the time
        this.emit('end')
      }
    })
    return
  }
}

module.exports = TailFile
