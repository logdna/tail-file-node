[![Coverage Status](https://coveralls.io/repos/github/logdna/tail-file-node/badge.svg?branch=main)](https://coveralls.io/github/logdna/tail-file-node?branch=main)

# TailFile

At LogDNA, consuming log files and making them searchable is what we do!
It all starts with the ability to efficiently watch log files on a local
host and send new lines up to the LogDNA service. This Node.js class provides
functionality like Unix's `tail -f` command, and we use it in our
agents to get the job done.  Of course, anything needing `tail` functionality
in Node.js could also benefit from using this.

---

* **[Features](#features)**
* **[Installation](#installation)**
* **[Usage](#usage)**
  * [Example consuming `data` events](#example-consuming-data-events)
  * [Example using `pipe`](#example-using-pipe)
  * [Example using `readline`](#example-using-readline)
  * [Example for Clean Shutdown](#example-for-clean-shutdown)
* **[Events](#events)**
  * [Event: 'flush'](#event-flush)
  * [Event: 'renamed'](#event-renamed)
  * [Event: 'retry'](#event-retry)
  * [Event: 'tail_error'](#event-tail_error)
  * [Event: 'truncated'](#event-truncated)
  * [Event: (Any `Readable` event)](#event-any-readable-event)
* **[API](#api)**
  * [Constructor: new TailLog(filename[, options])](#constructor-new-tailfilefilename-options)
  * [tail.start()](#tailstart)
  * [tail.quit()](#tailquit)
* **[Program Flow](#program-flow)**
* **[How Log Rolling is Handled](#how-log-rolling-is-handled)**
* **[Backpressure Pauses Polling](#backpressure-pauses-polling)**
  * [Log Rolling During Backpressure](#log-rolling-during-backpressure)


## Features

* Zero dependencies!  It's lightweight and uses 100% Node.js core modules.
* It implements a [`Readable`][] stream, which is efficient
  and flexible in terms of being able to `pipe` to other streams or consume via events.
* Stream backpressure is properly respected, so at no time is data pushed through the
  stream unless it is requested.
* It handles log rolling.  Renaming files is handled gracefully without losing lines
  written to the "old" file, no matter what the poll interval is.
* It handles file truncation, continuing to tail the file despite being truncated.

## Installation

```sh
npm install @logdna/tail-file
```

## Usage

Instantiate an instance by passing the full path of a file to tail.
This will return a stream that can be piped to other streams or consumed
via [`data` events][data]. To begin the tailing, call the [`start`](#tailstart) method.

### Example using `data` events

```js
const TailFile = require('@logdna/tail-file')

const tail = new TailFile('/path/to/your/logfile.txt', {encoding: 'utf8'})
  .on('data', (chunk) => {
    console.log(`Recieved a utf8 character chunk: ${chunk}`)
  })
  .on('tail_error', (err) => {
    console.error('TailFile had an error!', err)
  })
  .on('error', (err) => {
    console.error('A TailFile stream error was likely encountered', err)
  })
  .start()
  .catch((err) => {
    console.error('Cannot start.  Does the file exist?', err)
  })
```

### Example using `pipe`

This example is more realistic.  It pipes the output to a transform stream
which breaks the data up by newlines, emitting its own `data` event for
every line.

```js
const TailFile = require('@logdna/tail-file')
const split2 = require('split2') // A common and efficient line splitter

const tail = new TailFile('/path/to/your/logfile.txt')
tail
  .on('tail_error', (err) => {
    console.error('TailFile had an error!', err)
    throw err
  })
  .start()
  .catch((err) => {
    console.error('Cannot start.  Does the file exist?', err)
    throw err
  })

// Data won't start flowing until piping

tail
  .pipe(split2())
  .on('data', (line) => {
    console.log(line)
  })
```

### Example using `readline`

This is an easy way to get a "line splitter" by using Node.js core modules.
For tailing files with high throughput, an official `Transform` stream is
recommended since it will edge out `readline` slightly in performance.

```js
const readline = require('readline')
const TailFile = require('@logdna/tail-file')

async function startTail() {
  const tail = new TailFile('./somelog.txt')
    .on('tail_error', (err) => {
      console.error('TailFile had an error!', err)
    })

  try {
    await tail.start()
    const linesplitter = readline.createInterface({
      input: tail
    })

    linesplitter.on('line', (line) => {
      console.log(line)
    })
  } catch (err) {
    console.error('Cannot start.  Does the file exist?', err)
  }
}

startTail().catch((err) => {
  process.nextTick(() => {
    throw err
  })
})
```

### Example for Clean Shutdown

`TailFile` will call `flush()` when `quit()` is called.  Therefore, to exit  cleanly,
one must simply await the `quit` call.  If the implementation wishes to keep track of
the last position read from the file (for resuming in the same spot later, for example),
then a simple listener can be added to always track the file position.  That way, when
`quit()` is called, it will get properly updated.

```js
const TailFile = require('@logdna/tail-file')
let position // Can be used to resume the last position from a new instance

const tail = new TailFile('./somelog.txt')

process.on('SIGINT', () => {
  tail.quit()
    .then(() => {
      console.log(`The last read file position was: ${position}`)
    })
    .catch((err) => {
      process.nextTick(() => {
        console.error('Error during TailFile shutdown', err)
      })
    })
})

tail
  .on('flush', ({lastReadPosition}) => {
    position = lastReadPosition
  })
  .on('data', (chunk) => {
    console.log(chunk.toString())
  })
  .start()
  .catch((err) => {
    console.error('Cannot start.  Does the file exist?', err)
    throw err
  })
```

## Events

`TailFile` is a [`Readable` stream][`Readable`], so it can emit any events from that
superclass. Additionally, it will emit the following custom events.

### Event: `'flush'`

* [`<Object>`][]
  * `lastReadPosition` [`<Number>`][] - The current file position at `flush` time

This event is emitted when the underlying stream is done being read.
If backpressure is in effect, then `_read()` may be called multiple
times until it's flushed, so this event signals the end of the process.
It is used primarily in shutdown to make sure the data is exhausted,
but users may listen for this event if the relative "read position" in the
file is of interest.  For example, the `lastReadPosition` may be persisted to memory
or database for resuming `tail-file` on a separate execution without missing
any lines or duplicating them.

### Event: `'renamed'`

* [`<Object>`][]
  * `message` [`<String>`][] - Static message:
    `'The file was renamed or rolled. Tailing resumed from the beginning.'`
  * `filename` [`<String>`][] - The filename that's being tailed
  * `when` [`<Date>`][] - The date/time when the event happened

This event is emitted when a file with the same name is found, but has
a different inode than the previous poll. Commonly, this happens
during a log rotation.

### Event: `'retry'`

* [`<Object>`][]
  * `message` [`<String>`][] - Static message: `'File disappeared. Retrying.'`
  * `filename` [`<String>`][] - The filename that's being tailed
  * `attempts` [`<Number>`][] - The number of attempts to try and access the file
  * `when` [`<Date>`][] - The date/time when the event happened

If a file that was successfully being tailed goes away, `TailFile` will
try for `maxPollFailures` to re-poll the file.  For each of those retries,
this event is emitted for informative purposes.  Typically, this could happen
if log rolling is occurring manually, or timed in a way where the poll happens
during the time in which the "new" filename is not yet created.

### Event: `'tail_error'`

* [`<Error>`][]
  * `message` [`<String>`][] - The error message as written by `TailFile`
  * `code` [`<String>`][] - Static value of `ETAIL`
  * `meta` [`<Object>`][] - Additional metadata added for context
    * `actual` [`<Error>`][] - The actual error that was thrown, e.g. from a stream

When an error happens that is specific to `TailFile`, it cannot emit an `error` event
without causing the main stream to end (because it's a `Readable` implementation).
Therefore, if an error happens in a place such as reading the underlying file
resource, a `tail_error` event will be emitted instead.

### Event: `'truncated'`

* [`<Object>`][]
  * `message` [`<String>`][] - Static message:
    `'The file was truncated.  Tailing resumed from the beginning.'`
  * `filename` [`<String>`][] - The filename that's being tailed
  * `when` [`<Date>`][] - The date/time when the event happened

If a file is shortened or truncated without moving or renaming the file,
`TailFile` will assume it to be a new file, and it will start consuming
lines from the beginning of the file.  This event is emitted for informational
purposes about that behavior.

### Event: (Any [`Readable`][] event)

`TailFile` implements a [`Readable`][]
stream, so it may also emit these events.  The most common ones are `close`
(when `TailFile` exits), or `data` events from the stream.

## API

### Constructor: `new TailFile(filename[, options])`

* `filename` [`<String>`][] - The filename to tail.
  Poll errors do not happen until [`start`](#tailstart) is called.
* `options` [`<Object>`][] - **Optional**
  * `pollFileIntervalMs` [`<Number>`][] - How often to poll `filename` for changes.
    **Default:** `1000`ms
  * `pollFailureRetryMs` [`<Number>`][] - After a polling error (ENOENT?), how long to
    wait before retrying. **Default:** `200`ms
  * `maxPollFailures` [`<Number>`][] - The number of times to retry a failed poll
    before exiting/erroring. **Default:** `10` times.
  * `readStreamOpts` [`<Object>`][] - Options to pass to the
    [`fs.createReadStream`][createReadStream] function. This is used for reading bytes
    that have been added to `filename` between every poll.
  * `startPos` [`<Number>`][] - An integer representing the inital read position in
    the file. Useful for reading from `0`. **Default:** `null` (start tailing from EOF)
  * Any additional key-value options get passed to the [`Readable`][] superclass
    constructor of `TailFile`
* Throws: [`<TypeError>`][]|[`<RangeError>`][] if parameter validation fails
* Returns: `TailFile`, which is a [`Readable`][] stream

Instantiating `TailFile` will return a readable stream, but nothing will happen
until [`start()`](#start) is called.  After that, follow node's standard procedure to
get the stream into [flowing mode][reading modes].  Typically, this means using
`pipe` or attaching [`data`][data] listeners to the readable stream.

As the underlying `filename` is polled for changes, it will call
`fs.createReadStream` to efficiently read the changed bytes since the last poll.
To control the options of that stream, the key-values in `readStreamOpts` will
be passed to the `fs.createReadStream` constructor.  Similarly, options for
controlling `TailFile`'s' stream can be passed in via `options`, and they will
get passed through to the `Readable`'s `super()` constructor.
Useful settings such as `encoding: 'utf8'` can be used this way.

### `tail.start()`

* Returns: [`<Promise>`][] - Resolves after the file is polled successfully
* Rejects: If `filename` is not found

Calling `start()` begins the polling of `filename` to watch for added/changed bytes.
`start()` may be called before or after data is set up to be consumed with a
`data` listener or a `pipe`.  Standard node stream rules apply, which say
that data will not flow through the stream [until it's consumed][reading modes].

### `tail.quit()`

* Returns: `undefined`
* Emits: [`close`](#event-any-readable-event) when the parent `Readstream` is ended.

This function calls `flush`, then closes all streams and exits cleanly.  The parent `TailFile` stream will be
properly ended by pushing `null`, therefore an `end` event may be emitted as well.

## Program Flow

Using "file watcher" events don't always work across different operating systems,
therefore the most effective way to "tail" a file is to continuously poll
it for changes and read those changes when they're detected.
Even Unix's `tail -f` command works similarly.

Once `start()` is called, `TailFile` will being this polling process. As changes
are detected through a `.size` comparison, it uses `fs.openReadStream` to
efficiently read to the end of the file using [async/await iterators][].
This allows backpressure to be supported throughout the process.

## How Log Rolling is Handled

`TailFile` keeps a [`FileHandle`][] open for the `filename`, which is attached to an
inode.  If log rolling happens, `TailFile` uses the `FileHandle` to read the rest of the
"old" file before starting the process from the beginning of the newly-created file.
This ensures that no data is lost due to the rolling/renaming of `filename`.
This functionality assumes that `filename` is re-created with the same name,
otherwise an error is emitted if `filename` does not re-appear.

## Backpressure Pauses Polling

Because `TailFile` won't be consumed until it is in a [reading mode][reading modes],
this may cause backpressure to be enacted.  In other words, if `.start()` is called,
but `pipe` or [data events][data] are not immediately set up, `TailFile` may encounter
backpressure if its [`push()`][push] calls exceed the [high water mark][high water].
Backpressure can also happen if `TailFile` becomes unpiped.
In these cases, `TailFile` will stop polling and wait until data is flowing before
polling resumes.

### Log Rolling During Backpressure

If polling is off during backpressure, `TailFile` can handle
[a single log roll or rename](#how-log-rolling-is-handled) during backpressure, but if
the log is renamed more than once, there will most likely be data loss, as polling for
changes will be off.

This is an *extrememly unlikely* edge case, however we recommend consuming the `TailFile`
stream almost immediately upon creation.

[`<Promise>`]: https://mdn.io/promise
[`<Date>`]: https://mdn.io/date
[`<Number>`]: https://mdn.io/number
[`<Object>`]: https://mdn.io/object
[`<String>`]: https://mdn.io/string
[`<TypeError>`]: https://mdn.io/TypeError
[`<RangeError>`]: https://mdn.io/RangeError
[`<Error>`]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error
[`Readable`]: https://nodejs.org/dist/latest-v12.x/docs/api/stream.html#stream_class_stream_readable
[`FileHandle`]: https://nodejs.org/dist/latest-v12.x/docs/api/fs.html#fs_class_filehandle
[data]: https://nodejs.org/dist/latest-v12.x/docs/api/stream.html#stream_event_data
[createReadStream]: https://nodejs.org/dist/latest-v12.x/docs/api/fs.html#fs_fs_createreadstream_path_options
[reading modes]: https://nodejs.org/dist/latest-v12.x/docs/api/stream.html#stream_two_reading_modes
[async/await iterators]: https://nodejs.org/dist/latest-v12.x/docs/api/stream.html#stream_consuming_readable_streams_with_async_iterators
[push]: https://nodejs.org/dist/latest-v12.x/docs/api/stream.html#stream_readable_push_chunk_encoding
[high water]: https://nodejs.org/dist/latest-v12.x/docs/api/stream.html#stream_readable_readablehighwatermark
