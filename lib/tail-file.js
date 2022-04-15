'use strict'

const {Readable} = require('stream')
const fs = require('fs')
const {once} = require('events')

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
  }

  async start() {
    await this._openFile()
    await this._pollFileForChanges()
    return
  }

  async _openFile() {
    this[kFileHandle] = await fs.promises.open(this[kFileName], 'r')
    return
  }

  async _readRemainderFromFileHandle() {
    // Read the end of a renamed file before re-opening the new file.
    // Use the file handle since it remains open even if the file name has changed
    const fileHandleTemp = this[kFileHandle] // Prevent races when closing
    this[kFileHandle] = null
    const stats = await fileHandleTemp.stat()
    const lengthToEnd = stats.size - this[kStartPos]
    const {buffer} = await fileHandleTemp.read(
      Buffer.alloc(lengthToEnd)
    , 0
    , lengthToEnd
    , this[kStartPos]
    )
    this.push(buffer)
    await fileHandleTemp.close()
    return
  }

  async _readChunks(stream) {
    // For node 16 and higher: https://nodejs.org/docs/latest-v16.x/api/stream.html#readableiteratoroptions
    /* istanbul ignore next */
    const iterator = stream.iterator
      ? stream.iterator({destroyOnReturn: false})
      : stream

    for await (const chunk of iterator) {
      this[kStartPos] += chunk.length
      if (!this.push(chunk)) {
        this[kStream] = stream
        this[kPollTimer] = null
        return
      }
    }
    // Chunks read successfully (no backpressure)
    if (this[kStream]) {
      // Backpressure had been on, and polling was paused.  Resume here.
      this._scheduleTimer(this[kPollFileIntervalMs])
    }
    this[kStream] = null
    setImmediate(this.emit.bind(this), 'flush', {
      lastReadPosition: this[kStartPos]
    })
    return
  }

  async _pollFileForChanges() {
    try {
      const stats = await fs.promises.stat(this[kFileName])

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
            const err = new Error('Could not read remaining bytes from old FH')
            err.meta = {
              error: error.message
            , code: error.code
            }
            this.emit('tail_error', err)
          }
        }
        await this._openFile()
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
        if (this[kStream]) return // Pause polling if backpressure is on
      } else {
        setImmediate(this.emit.bind(this), 'flush', {
          lastReadPosition: this[kStartPos]
        })
      }

      this._scheduleTimer(this[kPollFileIntervalMs])

    } catch (err) {
      if (err.code === 'ENOENT') {
        if (this[kFileHandle]) {
          // The .stat() via polling may have happened during a file rename/roll.
          // Don't lose the last lines in the file if it previously existed.
          // Perhaps it has not been re-created yet (or won't be)
          try {
            await this._readRemainderFromFileHandle()
          } catch (error) {
            this.emit('tail_error', error)
          }
        }
        this[kPollFailureCount]++
        if (this[kPollFailureCount] >= this[kMaxPollFailures]) {
          return this.quit(err)
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
      return this.quit(err)
    }
    return
  }

  _scheduleTimer(ms) {
    clearTimeout(this[kPollTimer])
    if (this[kQuitting]) return
    this[kPollTimer] = setTimeout(this._pollFileForChanges.bind(this), ms)
    return
  }

  async _streamFileChanges() {
    try {
      const stream = fs.createReadStream(this[kFileName], {
        ...this[kOpts].readStreamOpts
      , start: this[kStartPos]
      })
      await this._readChunks(stream)
    } catch (err) {
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
    if (this[kStream]) {
      this._readChunks(this[kStream])
    }
    return
  }

  async quit(err) {
    this[kQuitting] = true
    clearTimeout(this[kPollTimer])

    if (err) {
      this.emit('error', err)
    } else {
      // One last read to get lines added in high throughput
      this._pollFileForChanges().catch(NOOP)
      await once(this, 'flush')
    }

    // Signal the end of this Readstream
    this.push(null)

    // Clean open file handles and streams
    if (this[kFileHandle]) {
      this[kFileHandle].close().catch(NOOP)
    }
    if (this[kStream]) {
      this[kStream].destroy()
    }

    process.nextTick(() => {
      if (this._readableState && !this._readableState.endEmitted) {
        // 'end' is not emitted unless data is flowing, but this makes
        // confusing inconsistencies, so emit it all the time
        this.emit('end')
      }
    })
    return
  }
}

module.exports = TailFile
