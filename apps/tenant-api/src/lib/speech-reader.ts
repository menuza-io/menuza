import { ENV } from 'varlock/env'
import { z } from 'zod'
import { fetchNoRedirect } from './fetch-no-redirect.ts'
import { getNodeRegion } from './region.ts'
import { syncEnvFromProcess } from './secrets.ts'

/**
 * Turns a spoken count into text (#488), through an OpenAI-compatible
 * `/audio/transcriptions` endpoint the operator provisions in THIS node's own
 * region. Same rule as the invoice reader: `SPEECH_COUNT_DATA_REGION` must equal
 * `DATA_REGION`; there is no public default and no cross-region fallback, so a
 * KSA recording never goes to a US model. With no endpoint (or one in another
 * region) the node reports no speech model and the microphone stays hidden.
 *
 * The recording is held in memory for this one call and is never written
 * anywhere: only the text comes back, and only that text is ever kept. The
 * model's answer is untrusted text: it is cut to length and stripped of control
 * characters, then read by `parseSpokenCount`, then shown to a person.
 */

export function isSpeechReaderConfigured(): boolean {
	// The Node entry sets values on `process.env`: read them in before looking.
	syncEnvFromProcess()
	return Boolean(
		ENV.SPEECH_COUNT_BASE_URL &&
		ENV.SPEECH_COUNT_MODEL &&
		ENV.SPEECH_COUNT_API_KEY &&
		ENV.SPEECH_COUNT_DATA_REGION === getNodeRegion(),
	)
}

/** Longest recording accepted: about a minute of compressed speech. */
export const SPEECH_MAX_BYTES = 2_000_000
export const SPEECH_AUDIO_TYPES = [
	'audio/webm',
	'audio/ogg',
	'audio/mp4',
	'audio/mpeg',
	'audio/wav',
	'audio/x-wav',
	'audio/x-m4a',
	'audio/aac',
] as const

export type SpeechAudio = { bytes: Uint8Array; contentType: string }
export type SpeechHints = {
	/** Item names, so the model spells them the way the catalog does. */
	vocabulary: string[]
	language?: 'en' | 'ar' | null
}

const answerSchema = z.object({ text: z.string() })

const clean = (value: string, max: number) =>
	value
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, max)

const EXTENSION: Record<string, string> = {
	'audio/webm': 'webm',
	'audio/ogg': 'ogg',
	'audio/mp4': 'mp4',
	'audio/mpeg': 'mp3',
	'audio/wav': 'wav',
	'audio/x-wav': 'wav',
	'audio/x-m4a': 'm4a',
	'audio/aac': 'aac',
}

async function transcribeWithEndpoint(
	audio: SpeechAudio,
	hints: SpeechHints,
): Promise<string> {
	syncEnvFromProcess()
	const baseUrl = (ENV.SPEECH_COUNT_BASE_URL ?? '').replace(/\/$/, '')
	const type = audio.contentType.toLowerCase().split(';')[0]!.trim()
	const form = new FormData()
	form.set('model', ENV.SPEECH_COUNT_MODEL ?? '')
	form.set('response_format', 'json')
	form.set('temperature', '0')
	if (hints.language) form.set('language', hints.language)
	if (hints.vocabulary.length > 0) {
		form.set('prompt', clean(hints.vocabulary.join(', '), 800))
	}
	form.set(
		'file',
		new Blob([audio.bytes as BlobPart], { type: type || 'audio/webm' }),
		`count.${EXTENSION[type] ?? 'webm'}`,
	)
	const response = await fetchNoRedirect(`${baseUrl}/audio/transcriptions`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${ENV.SPEECH_COUNT_API_KEY}` },
		signal: AbortSignal.timeout(30_000),
		body: form,
	})
	if (!response.ok) throw new Error('Speech reader unavailable')
	return clean(answerSchema.parse(await response.json()).text, 1000)
}

/**
 * The seam tests (and a different provider) replace: given a recording, answer
 * the words. Never throws on an empty recording: it answers an empty string.
 */
export const speechReaderDeps: {
	transcribe: (audio: SpeechAudio, hints: SpeechHints) => Promise<string>
} = { transcribe: transcribeWithEndpoint }

export async function transcribeAudio(
	audio: SpeechAudio,
	hints: SpeechHints,
): Promise<string> {
	if (!isSpeechReaderConfigured()) {
		throw new Error('Speech reader is not configured')
	}
	return clean(await speechReaderDeps.transcribe(audio, hints), 1000)
}
