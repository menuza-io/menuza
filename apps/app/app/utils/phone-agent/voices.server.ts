import { type AgentLanguage, fillMessage } from '@repo/phone-agent'
import { ENV } from 'varlock/env'
import { z } from 'zod'
import {
	checkRateLimit,
	type RateLimitConfig,
} from '#app/utils/rate-limit.server.ts'
import { businessMessageVariables } from './vertical.ts'

const CARTESIA_API = 'https://api.cartesia.ai'
const CARTESIA_VERSION = '2026-08-14'
/** The voice worker's model, so previews sound like real calls. */
const PREVIEW_MODEL = 'sonic-3'
const REQUEST_TIMEOUT_MS = 10_000
/** Cartesia sample clips are a few seconds long; anything bigger is refused. */
const MAX_SAMPLE_BYTES = 2_000_000
export const VOICE_PAGE_SIZE = 24
const PREVIEW_TEXT_MAX = 500

// Each greeting preview is a billed text-to-speech request. Past the limit,
// previews fall back to Cartesia's free sample clip.
export const VOICE_PREVIEW_RATE_LIMIT: RateLimitConfig = {
	scope: 'phone-agent-voice-preview',
	maxRequests: process.env.NODE_ENV === 'development' ? 500 : 60,
	windowMs: 60 * 60 * 1000,
}

export const VOICE_GENDERS = [
	'feminine',
	'masculine',
	'gender_neutral',
] as const
export type VoiceGender = (typeof VOICE_GENDERS)[number]

/** Cartesia voice ids are UUIDs; this stays loose but URL-safe. */
export const VoiceIdSchema = z
	.string()
	.trim()
	.regex(/^[A-Za-z0-9_-]{1,120}$/u)

const CartesiaVoiceSchema = z.object({
	id: z.string(),
	name: z.string(),
	tagline: z.string().nullish(),
	description: z.string().nullish(),
	gender: z.string().nullish(),
	language: z.string().nullish(),
	country: z.string().nullish(),
	preview_file_url: z.string().url().nullish(),
})

const CartesiaVoiceListSchema = z.object({
	data: z.array(CartesiaVoiceSchema),
	has_more: z.boolean().optional(),
	next_page: z.string().nullish(),
})

export type VoiceSummary = {
	id: string
	name: string
	tagline: string | null
	description: string | null
	gender: VoiceGender | null
	language: string | null
	country: string | null
	hasSample: boolean
}

export function cartesiaConfigured() {
	return Boolean(ENV.CARTESIA_API_KEY)
}

function cartesiaHeaders(): Record<string, string> {
	const key = ENV.CARTESIA_API_KEY ?? ''
	return {
		'Cartesia-Version': CARTESIA_VERSION,
		Authorization: `Bearer ${key}`,
		'X-API-Key': key,
	}
}

function toSummary(voice: z.infer<typeof CartesiaVoiceSchema>): VoiceSummary {
	const gender = VOICE_GENDERS.find((value) => value === voice.gender) ?? null
	return {
		id: voice.id,
		name: voice.name,
		tagline: voice.tagline || null,
		description: voice.description || null,
		gender,
		language: voice.language || null,
		country: voice.country || null,
		hasSample: Boolean(voice.preview_file_url),
	}
}

export type VoiceSearch = {
	query?: string | null
	language?: string | null
	gender?: VoiceGender | null
	cursor?: string | null
}

export async function searchVoices(search: VoiceSearch) {
	const params = new URLSearchParams({ limit: String(VOICE_PAGE_SIZE) })
	params.append('expand[]', 'preview_file_url')
	if (search.query?.trim()) params.set('q', search.query.trim().slice(0, 100))
	if (search.language) params.set('language', search.language)
	if (search.gender) params.set('gender', search.gender)
	if (search.cursor) params.set('starting_after', search.cursor)
	const response = await fetch(`${CARTESIA_API}/voices?${params}`, {
		headers: cartesiaHeaders(),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	})
	if (!response.ok) {
		throw new Error(`Cartesia voice search failed (${response.status})`)
	}
	const parsed = CartesiaVoiceListSchema.parse(await response.json())
	const voices = parsed.data.map(toSummary)
	return {
		voices,
		nextCursor: parsed.has_more
			? (parsed.next_page ?? voices.at(-1)?.id ?? null)
			: null,
	}
}

async function fetchVoice(voiceId: string) {
	const response = await fetch(
		`${CARTESIA_API}/voices/${encodeURIComponent(voiceId)}?expand[]=preview_file_url`,
		{
			headers: cartesiaHeaders(),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		},
	)
	if (response.status === 404) return null
	if (!response.ok) {
		throw new Error(`Cartesia voice lookup failed (${response.status})`)
	}
	return CartesiaVoiceSchema.parse(await response.json())
}

export async function getVoice(voiceId: string) {
	const voice = await fetchVoice(voiceId)
	return voice ? toSummary(voice) : null
}

/** What the caller would hear when the AI assistant picks up. */
export function previewTranscript(input: {
	orgName: string
	agentName: string
	greeting: string
}) {
	const agentName = input.agentName.trim().slice(0, 60)
	const greeting = fillMessage(
		input.greeting.trim().slice(0, 400),
		businessMessageVariables(input.orgName),
	)
	return [agentName ? `I'm ${agentName}.` : '', greeting]
		.filter(Boolean)
		.join(' ')
		.slice(0, PREVIEW_TEXT_MAX)
}

async function synthesize(input: {
	voiceId: string
	language: AgentLanguage
	transcript: string
}) {
	const response = await fetch(`${CARTESIA_API}/tts/bytes`, {
		method: 'POST',
		headers: { ...cartesiaHeaders(), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			model_id: PREVIEW_MODEL,
			transcript: input.transcript,
			voice: input.voiceId,
			language: input.language,
			output_format: {
				container: 'mp3',
				sample_rate: 24000,
				bit_rate: 64000,
			},
		}),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2),
	})
	if (!response.ok) {
		throw new Error(`Cartesia speech failed (${response.status})`)
	}
	return {
		body: await response.arrayBuffer(),
		contentType: response.headers.get('content-type') || 'audio/mpeg',
	}
}

async function fetchSample(voiceId: string) {
	const voice = await fetchVoice(voiceId)
	if (!voice?.preview_file_url) return null
	// The clip URL comes from Cartesia; it gets no credentials.
	const response = await fetch(voice.preview_file_url, {
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	})
	if (!response.ok) return null
	const length = Number(response.headers.get('content-length') ?? 0)
	if (length > MAX_SAMPLE_BYTES) return null
	const body = await response.arrayBuffer()
	if (body.byteLength > MAX_SAMPLE_BYTES) return null
	return {
		body,
		contentType: response.headers.get('content-type') || 'audio/mpeg',
	}
}

export type VoicePreview = {
	kind: 'greeting' | 'sample'
	body: ArrayBuffer
	contentType: string
}

/**
 * The greeting spoken in the voice, or Cartesia's sample clip when there's
 * no greeting, the preview limit is reached, or speech fails.
 */
export async function getVoicePreview(input: {
	organizationId: string
	userId: string
	voiceId: string
	language: AgentLanguage
	transcript: string
}): Promise<VoicePreview | null> {
	if (input.transcript) {
		const limit = await checkRateLimit(
			{ type: 'user', value: `${input.userId}:${input.organizationId}` },
			VOICE_PREVIEW_RATE_LIMIT,
		)
		if (limit.allowed) {
			try {
				return { kind: 'greeting', ...(await synthesize(input)) }
			} catch (error) {
				console.error('Voice preview speech failed', error)
			}
		}
	}
	try {
		const sample = await fetchSample(input.voiceId)
		return sample ? { kind: 'sample', ...sample } : null
	} catch (error) {
		console.error('Voice sample failed', error)
		return null
	}
}
