import { type ReadableStream, TransformStream } from 'node:stream/web'
import { applyPronunciations, type Pronunciation } from '@repo/phone-agent'

/** Phrase-ending punctuation followed by whitespace, in Latin and Arabic text. */
const BOUNDARY = /[.!?,;:،؛؟\n]\s+/gu
/** Past this, text is released at the last space so speech never stalls. */
const MAX_BUFFER_CHARS = 300

function releasePoint(buffer: string) {
	let cut = 0
	for (const match of buffer.matchAll(BOUNDARY)) {
		cut = match.index + match[0].length
	}
	if (cut === 0 && buffer.length > MAX_BUFFER_CHARS) {
		cut = buffer.lastIndexOf(' ') + 1
	}
	return cut
}

/**
 * Exact lines the voice must read as written, such as the required AI and
 * recording notices: owner pronunciations must not reword them.
 */
export class VerbatimSpeech {
	readonly #texts = new Set<string>()

	add(text: string) {
		this.#texts.add(text)
	}

	has(text: string) {
		return this.#texts.has(text)
	}
}

/**
 * A TTS text transform that swaps in the owner's spoken forms. LLM text
 * streams in token by token, so text is held until a phrase boundary to keep
 * multi-word terms whole. Only the voice hears it; transcripts keep the
 * original words.
 *
 * `session.say(text)` streams its text as one chunk, so a stream whose first
 * chunk is a `verbatim` line is passed through untouched. That only holds
 * while this transform runs before any other, which could re-chunk the text.
 */
export function pronunciationTransform(
	pronunciations: readonly Pronunciation[],
	verbatim?: VerbatimSpeech,
) {
	return (text: ReadableStream<string>): ReadableStream<string> => {
		if (!pronunciations.length) return text
		let buffer = ''
		let first = true
		let passThrough = false
		return text.pipeThrough(
			new TransformStream<string, string>({
				transform(chunk, controller) {
					if (first) {
						first = false
						passThrough = verbatim?.has(chunk) ?? false
					}
					if (passThrough) {
						controller.enqueue(chunk)
						return
					}
					buffer += chunk
					const cut = releasePoint(buffer)
					if (cut === 0) return
					controller.enqueue(
						applyPronunciations(buffer.slice(0, cut), pronunciations),
					)
					buffer = buffer.slice(cut)
				},
				flush(controller) {
					if (buffer) {
						controller.enqueue(applyPronunciations(buffer, pronunciations))
					}
				},
			}),
		)
	}
}
