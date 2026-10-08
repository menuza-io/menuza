import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rateLimit = vi.hoisted(() => ({ allowed: true }))

vi.mock('varlock/env', () => ({ ENV: { CARTESIA_API_KEY: 'test-key' } }))
vi.mock('#app/utils/rate-limit.server.ts', () => ({
	checkRateLimit: vi.fn(async () => ({
		allowed: rateLimit.allowed,
		resetAt: new Date(),
	})),
}))

const { getVoicePreview, previewTranscript, searchVoices } =
	await import('./voices.server.ts')

const voice = {
	id: 'voice-1',
	name: 'Katie',
	description: 'Friendly and clear',
	gender: 'feminine',
	language: 'en',
	preview_file_url: 'https://files.cartesia.ai/voice-1.mp3',
}

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

function audio(bytes: number, type = 'audio/mpeg') {
	return new Response(new Uint8Array(bytes), {
		headers: { 'Content-Type': type, 'Content-Length': String(bytes) },
	})
}

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
	rateLimit.allowed = true
	fetchMock.mockReset()
	vi.stubGlobal('fetch', fetchMock)
	vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

function requestUrl(call: number) {
	const input = fetchMock.mock.calls[call]?.[0]
	return new URL(String(input))
}

describe('previewTranscript', () => {
	it('introduces the agent and fills greeting placeholders', () => {
		expect(
			previewTranscript({
				orgName: 'Saffron',
				agentName: ' Maya ',
				greeting: 'Thanks for calling {business}!',
			}),
		).toBe("I'm Maya. Thanks for calling Saffron!")
	})

	it('is empty when there is nothing to read', () => {
		expect(
			previewTranscript({ orgName: 'Saffron', agentName: '', greeting: ' ' }),
		).toBe('')
	})
})

describe('searchVoices', () => {
	it('passes filters and returns a cursor when more pages exist', async () => {
		fetchMock.mockResolvedValueOnce(
			json({ data: [voice], has_more: true, next_page: null }),
		)
		const result = await searchVoices({
			query: ' warm ',
			language: 'es',
			gender: 'feminine',
			cursor: 'voice-0',
		})
		const url = requestUrl(0)
		expect(url.pathname).toBe('/voices')
		expect(url.searchParams.get('q')).toBe('warm')
		expect(url.searchParams.get('language')).toBe('es')
		expect(url.searchParams.get('gender')).toBe('feminine')
		expect(url.searchParams.get('starting_after')).toBe('voice-0')
		expect(url.searchParams.getAll('expand[]')).toEqual(['preview_file_url'])
		expect(result).toEqual({
			voices: [
				{
					id: 'voice-1',
					name: 'Katie',
					tagline: null,
					description: 'Friendly and clear',
					gender: 'feminine',
					language: 'en',
					country: null,
					hasSample: true,
				},
			],
			nextCursor: 'voice-1',
		})
	})

	it('has no cursor on the last page', async () => {
		fetchMock.mockResolvedValueOnce(json({ data: [voice], has_more: false }))
		const result = await searchVoices({})
		expect(result.nextCursor).toBeNull()
	})

	it('throws when Cartesia fails', async () => {
		fetchMock.mockResolvedValueOnce(json({}, 500))
		await expect(searchVoices({})).rejects.toThrow('500')
	})
})

describe('getVoicePreview', () => {
	const input = {
		organizationId: 'org_1',
		userId: 'user_1',
		voiceId: 'voice-1',
		language: 'en' as const,
		transcript: "I'm Maya. Thanks for calling Saffron!",
	}

	it('speaks the greeting in the chosen voice', async () => {
		fetchMock.mockResolvedValueOnce(audio(10))
		const preview = await getVoicePreview(input)
		expect(preview?.kind).toBe('greeting')
		const url = requestUrl(0)
		expect(url.pathname).toBe('/tts/bytes')
		const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
		expect(body).toMatchObject({
			transcript: input.transcript,
			voice: 'voice-1',
			language: 'en',
		})
	})

	it('falls back to the sample clip past the preview limit', async () => {
		rateLimit.allowed = false
		fetchMock.mockResolvedValueOnce(json(voice)).mockResolvedValueOnce(audio(5))
		const preview = await getVoicePreview(input)
		expect(preview?.kind).toBe('sample')
		expect(requestUrl(0).pathname).toBe('/voices/voice-1')
		expect(String(fetchMock.mock.calls[1]?.[0])).toBe(voice.preview_file_url)
	})

	it('falls back to the sample clip when speech fails', async () => {
		fetchMock
			.mockResolvedValueOnce(json({}, 500))
			.mockResolvedValueOnce(json(voice))
			.mockResolvedValueOnce(audio(5))
		expect((await getVoicePreview(input))?.kind).toBe('sample')
	})

	it('uses the sample clip when there is no greeting', async () => {
		fetchMock.mockResolvedValueOnce(json(voice)).mockResolvedValueOnce(audio(5))
		const preview = await getVoicePreview({ ...input, transcript: '' })
		expect(preview?.kind).toBe('sample')
	})

	it('refuses oversized sample clips', async () => {
		rateLimit.allowed = false
		fetchMock
			.mockResolvedValueOnce(json(voice))
			.mockResolvedValueOnce(audio(2_000_001))
		expect(await getVoicePreview(input)).toBeNull()
	})

	it('returns null when the voice has no sample', async () => {
		rateLimit.allowed = false
		fetchMock.mockResolvedValueOnce(json({ ...voice, preview_file_url: null }))
		expect(await getVoicePreview(input)).toBeNull()
	})
})
