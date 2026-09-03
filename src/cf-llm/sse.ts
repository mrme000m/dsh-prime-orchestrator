/**
 * Decode an SSE byte stream into event `data` payloads. The bundle has no
 * `eventsource-parser` dependency and must not add one, so this is a small
 * spec-strict hand-rolled parser: it reassembles reads that split anywhere
 * (including mid-UTF-8), handles CRLF and a leading BOM, skips comments
 * (`:`-prefixed lines) and non-`data:` fields, joins multi-`data:` lines per
 * the WHATWG event-stream algorithm, and dispatches an event only on its
 * blank-line terminator. The literal `[DONE]` is yielded so the caller owns
 * final flushing; EOF before it raises `LlmError('STREAM_CLOSED')`.
 *
 * @module dsh-prime-orchestrator/cf-llm/sse
 */

import { LlmError } from '@deepseek-ai/dsh-llm'

/** The terminal payload Workers AI (and OpenAI) send after the last chunk. */
export const DONE = '[DONE]'

/** Reassembling state for one in-flight SSE event. */
interface EventBuffer {
  dataLines: string[]
}

/**
 * Handle one complete line per the WHATWG event-stream algorithm. Blank lines
 * dispatch the buffered event; `data:`-prefixed lines accumulate; comments and
 * every other field are skipped (comments report transport activity).
 */
function handleLine(line: string, buffer: EventBuffer, onComment?: (comment: string) => void): string | undefined {
  if (line === '') {
    if (buffer.dataLines.length === 0) return undefined
    const data = buffer.dataLines.join('\n')
    buffer.dataLines = []
    return data
  }
  if (line.startsWith(':')) {
    onComment?.(line.slice(1).replace(/^ /, ''))
    return undefined
  }
  const colon = line.indexOf(':')
  const field = colon === -1 ? line : line.slice(0, colon)
  let value = colon === -1 ? '' : line.slice(colon + 1)
  if (value.startsWith(' ')) value = value.slice(1)
  if (field === 'data') buffer.dataLines.push(value)
  // event:, id:, retry:, and future fields carry nothing this parser consumes.
  return undefined
}

/** One line-terminator match: the line's extent and where the remainder starts. */
interface NewlineMatch {
  /** Length of the terminator's preceding line. */
  end: number
  /** Index just past the terminator (handles CR, LF, and CRLF). */
  next: number
}

/** Find the first line terminator in `text`, accepting CR, LF, and CRLF. */
function searchNewline(text: string): NewlineMatch | undefined {
  const cr = text.indexOf('\r')
  const lf = text.indexOf('\n')
  if (cr === -1 && lf === -1) return undefined
  if (cr === -1 || (lf !== -1 && lf < cr)) return { end: lf, next: lf + 1 }
  if (text[cr + 1] === '\n') return { end: cr, next: cr + 2 }
  return { end: cr, next: cr + 1 }
}

/**
 * Parse an SSE byte stream into data payloads. Yields `[DONE]` as the final
 * value and returns; throws `LlmError('STREAM_CLOSED')` when the stream ends
 * without it (truncated response — the model call cannot be trusted).
 * @param stream - raw SSE bytes; reads may split anywhere, including mid-UTF-8 sequence.
 * @param onComment - optional transport-activity callback; comments never enter the yielded payload stream.
 * @returns each event's data payload in arrival order, the `[DONE]` sentinel last.
 */
export async function* parseSse(
  stream: ReadableStream<BufferSource>,
  onComment?: (comment: string) => void,
): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8')
  const buffer: EventBuffer = { dataLines: [] }
  let pending = ''
  let seenBom = false
  const dispatch = (line: string): string | undefined => handleLine(line, buffer, onComment)
  const emit: string[] = []
  const feedLine = (line: string): void => {
    const data = dispatch(line)
    if (data !== undefined) emit.push(data)
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      let text = decoder.decode(value, { stream: true })
      if (!seenBom && text.startsWith('\ufeff')) {
        text = text.slice(1)
        seenBom = true
      }
      seenBom = true
      pending += text
      let newline = searchNewline(pending)
      while (newline !== undefined) {
        const line = pending.slice(0, newline.end)
        pending = pending.slice(newline.next)
        feedLine(line)
        newline = searchNewline(pending)
      }
      // A synchronous callback cannot yield, so dispatched payloads drain
      // here, inside the read loop and before the next read is awaited.
      for (const data of emit.splice(0)) {
        yield data
        if (data === DONE) return
      }
    }
    pending += decoder.decode()
    // A final unterminated line is truncation under the strict framing: an
    // event dispatches only on its blank-line terminator. The [DONE]
    // sentinel never arrives that way, so EOF here is STREAM_CLOSED below.
  } catch (error: unknown) {
    // Reader cancellation surfaces as a TypeError; the caller's signal owns
    // the diagnosis. Re-throw LlmError untouched, wrap anything else.
    if (error instanceof LlmError) throw error
    throw new LlmError('Workers AI SSE stream failed while reading', 'TRANSPORT', { cause: error })
  } finally {
    reader.releaseLock()
  }
  throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED')
}
