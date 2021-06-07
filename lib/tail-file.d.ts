import { Readable, ReadableOptions } from 'stream'
import * as fs from 'fs'


type ReadStreamOpts = Exclude<Parameters<typeof fs.createReadStream>[1], string | undefined>

interface EventPayload {
  /**
   * A static message.
   */
  message: string
  /**
   * The filename that's being tailed.
   */
  filename: string
  /**
   * The date/time when the event happened.
   */
  when: Date
}

interface RetryEventPayload extends EventPayload {
  /**
   * The number of attempts to try and access the file.
   */
  attempts: number
}

interface FlushEventPayload {
  /**
   * The `lastReadPosition` represents the `startPos` value at the time of flushing
   */
  lastReadPosition: number
}

interface TailErrorEventPayload {
  /**
   * The error message as written by `TailFile`.
   */
  message: string
  /**
   * A static error code.
   */
  code: 'ETAIL'
  /**
   * Additional metadata added for context.
   */
  meta: {
    [key: string]: unknown
    /**
     * The actual error that was thrown, e.g. from a stream.
     */
    actual: Error
  }
}

// Events declared on Readable.
interface ReadableEvents {
  close: () => void
  data: (chunk: any) => void
  end: () => void
  error: (err: Error) => void
  pause: () => void
  readable: () => void
  resume: () => void
}

interface TailFileEvents extends ReadableEvents {
  flush: (payload: FlushEventPayload) => void
  renamed: (payload: EventPayload) => void
  retry: (payload: RetryEventPayload) => void
  tail_error: (payload: TailErrorEventPayload) => void
  truncated: (payload: EventPayload) => void
}


declare namespace TailFile {
  // NOTE: All types in this scope are implicitly exported.

  interface TailFileOptions extends ReadableOptions {
    /**
     * How often to poll filename for changes (in milliseconds).
     * @default 1000
     */
    pollFileIntervalMs?: number
    /**
     * After a polling error (ENOENT?), how long to wait before retrying (in milliseconds).
     * @default 200
     */
    pollFailureRetryMs?: number
    /**
     * The number of times to retry a failed poll before exiting/erroring.
     * @default 10
     */
    maxPollFailures?: number
    /**
     * Options to pass to the `fs.createReadStream` function.
     * This is used for reading bytes that have been added to filename between every poll.
     */
    readStreamOpts?: ReadStreamOpts

    /**
     * An integer representing the initial read position in the file, or `null`
     * for start tailing from EOF.
     * Useful for reading from 0.
     *
     * @default null
     */
    startPos?: number | null
  }
}

declare class TailFile extends Readable {
  /**
   * Instantiating `TailFile` will return a readable stream, but nothing will
   * happen until `start()` is called. After that, follow node's standard
   * procedure to get the stream into flowing mode. Typically, this means
   * using `pipe` or attaching `data` listeners to the readable stream.
   *
   * @param filename The filename to tail. Poll errors do not happen until `start` is called.
   * @param opts Optional options.
   * @throws {TypeError | RangeError} if parameter validation fails.
   */
  constructor(filename: string, opts?: TailFile.TailFileOptions)

  /**
   * Beings the polling of `filename` to watch for added/changed bytes.
   * It may be called before or after data is set up to be consumed with a
   * `data` listener or a `pipe`. Standard node stream rules apply, which say
   * that data will not flow through the stream until it's consumed.
   *
   * @returns A Promise that resolves after the file is polled successfully,
   *   rejects if `filename` is not found.
   */
  start(): Promise<void>

  /**
   * Closes all streams and exits cleanly. The parent `TailFile` stream will
   * be properly ended by pushing null, therefore an end event may be emitted
   * as well.
   *
   * @emits close when the parent `ReadStream` is ended.
   */
  quit(): Promise<void>

  // Event emitter

  addListener<U extends keyof TailFileEvents>(event: U, listener: TailFileEvents[U]): this
  addListener(event: string | symbol, listener: (...args: any[]) => void): this

  emit<U extends keyof TailFileEvents>(event: U): boolean
  emit(event: string | symbol, ...args: any[]): boolean

  on<U extends keyof TailFileEvents>(event: U, listener: TailFileEvents[U]): this
  on(event: string | symbol, listener: (...args: any[]) => void): this

  once<U extends keyof TailFileEvents>(event: U, listener: TailFileEvents[U]): this
  once(event: string | symbol, listener: (...args: any[]) => void): this

  prependListener<U extends keyof TailFileEvents>(event: U, listener: TailFileEvents[U]): this
  prependListener(event: string | symbol, listener: (...args: any[]) => void): this

  prependOnceListener<U extends keyof TailFileEvents>(event: U, listener: TailFileEvents[U]): this
  prependOnceListener(event: string | symbol, listener: (...args: any[]) => void): this

  removeListener<U extends keyof TailFileEvents>(event: U, listener: TailFileEvents[U]): this
  removeListener(event: string | symbol, listener: (...args: any[]) => void): this
}

// NOTE: Do not rewrite it into `export default` unless tail-file's `main`
// entrypoint actually exports `default`.
export = TailFile
