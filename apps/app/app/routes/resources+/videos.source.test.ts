import { beforeEach, describe, expect, it, vi } from 'vitest'
import { signMediaId } from '#app/utils/media-signing.server.ts'
import { loader } from './videos.source.ts'

vi.hoisted(() => {
	process.env.SESSION_SECRET ||= 'test-session-secret-for-media-signing'
})

const getUserId = vi.hoisted(() => vi.fn())
vi.mock('@repo/auth', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getUserId,
}))

vi.mock('#app/utils/storage.server.ts', () => ({
	getSignedGetRequestInfoAsync: vi.fn(async () => ({
		url: 'https://storage.example.test/object',
		headers: {},
	})),
	getSignedHeadRequestInfoAsync: vi.fn(async () => ({
		url: 'https://storage.example.test/object',
		headers: {},
	})),
}))

const NOTE_VIDEO_KEY = 'orgs/org1/notes/note1/videos/1700000000-abc.mp4'

function signedNoteVideoUrl() {
	const expires = Math.floor(Date.now() / 1000) + 3600
	const sig = signMediaId(NOTE_VIDEO_KEY, expires)
	const params = new URLSearchParams({
		objectKey: NOTE_VIDEO_KEY,
		sig,
		expires: String(expires),
	})
	return `https://app.example.test/resources/videos/source?${params}`
}

function stubStorage(contentType: string) {
	vi.stubGlobal(
		'fetch',
		vi.fn(
			async () =>
				new Response('bytes', { headers: { 'content-type': contentType } }),
		),
	)
}

async function statusOf(url: string) {
	try {
		await loader({ request: new Request(url) } as any)
		return 200
	} catch (error) {
		if (error instanceof Response) return error.status
		throw error
	}
}

describe('/resources/videos/source authorization', () => {
	beforeEach(() => getUserId.mockResolvedValue(null))

	it('answers 404 for a key that is not a registered media asset', async () => {
		expect(
			await statusOf(
				'https://app.example.test/resources/videos/source?objectKey=users/someone/secret-file.mp4&organizationId=org1',
			),
		).toBe(404)
	})

	it('rejects a malformed key before any lookup', async () => {
		expect(
			await statusOf(
				'https://app.example.test/resources/videos/source?objectKey=../../etc/passwd-aaaaaaaa',
			),
		).toBe(400)
	})

	it('refuses an unsigned note video', async () => {
		stubStorage('video/mp4')
		expect(
			await statusOf(
				`https://app.example.test/resources/videos/source?objectKey=${NOTE_VIDEO_KEY}`,
			),
		).toBe(401)
		vi.unstubAllGlobals()
	})

	it('serves a signed note video, as video only', async () => {
		stubStorage('video/mp4')
		expect(await statusOf(signedNoteVideoUrl())).toBe(200)
		vi.unstubAllGlobals()
	})

	it.each(['text/html', 'image/svg+xml', 'application/octet-stream'])(
		'refuses to pass through %s from storage',
		async (type) => {
			stubStorage(type)
			expect(await statusOf(signedNoteVideoUrl())).toBe(415)
			vi.unstubAllGlobals()
		},
	)

	it('does not serve an unregistered key outside the note-video contract', async () => {
		stubStorage('video/mp4')
		expect(
			await statusOf(
				'https://app.example.test/resources/videos/source?objectKey=orgs/org1/comments/c1/images/1700000000-abc.mp4',
			),
		).toBe(404)
		vi.unstubAllGlobals()
	})
})
