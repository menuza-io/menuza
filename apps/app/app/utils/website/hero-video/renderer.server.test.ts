import {
	HERO_VIDEO_MAX_BYTES,
	HERO_VIDEO_POSTER_MAX_BYTES,
	buildStoryboard,
} from '@repo/common/hero-video'
import { describe, expect, it, vi } from 'vitest'
import {
	checkRenderOutput,
	createHttpHeroVideoRenderer,
	createMockHeroVideoRenderer,
	getHeroVideoRenderer,
} from './renderer.server.ts'

const plan = buildStoryboard({ style: 'slow_pans', photoCount: 3 })
const stills = [0, 1, 2].map((i) => ({
	url: `https://signed.test/photo-${i}.jpg`,
	mimeType: 'image/jpeg',
	width: 1600,
	height: 900,
	bytes: new Uint8Array([i + 1, 2, 3]),
}))

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

describe('the mock renderer (#301)', () => {
	it('makes a fixture clip and takes the poster from the first photo, never a model', async () => {
		const renderer = createMockHeroVideoRenderer()
		const out = await renderer.render({ plan, stills })
		expect(out).toMatchObject({
			ok: true,
			videoMimeType: 'video/mp4',
			posterMimeType: 'image/jpeg',
		})
		if (!out.ok) return
		expect([...out.poster]).toEqual([1, 2, 3])
		expect(renderer.calls[0]!.stills).toHaveLength(3)
	})
	it('can fail or return too much', async () => {
		expect(
			await createMockHeroVideoRenderer({ fail: true }).render({
				plan,
				stills,
			}),
		).toEqual({
			ok: false,
			error: 'renderer_failed',
		})
		expect(
			await createMockHeroVideoRenderer({ tooLarge: true }).render({
				plan,
				stills,
			}),
		).toEqual({
			ok: false,
			error: 'output_too_large',
		})
	})
})

describe('the HTTP renderer (#301)', () => {
	const options = {
		url: 'https://renderer.example/render',
		token: 'secret-token',
	}

	it('sends the plan and short-lived photo links with the bearer token, nothing else', async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				video: b64(new Uint8Array([1, 2, 3, 4])),
				poster: b64(new Uint8Array([9, 9])),
				videoMimeType: 'video/mp4',
				posterMimeType: 'image/jpeg',
			}),
		)
		const out = await createHttpHeroVideoRenderer({
			...options,
			fetch: fetchMock as never,
		}).render({ plan, stills })
		expect(out).toMatchObject({ ok: true })
		if (!out.ok) return
		expect([...out.video]).toEqual([1, 2, 3, 4])
		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		]
		expect(url).toBe(options.url)
		expect((init.headers as Record<string, string>).Authorization).toBe(
			'Bearer secret-token',
		)
		expect(init.redirect).toBe('manual')
		const body = JSON.parse(String(init.body)) as {
			stills: Array<Record<string, unknown>>
		}
		// Links and sizes only: no bytes go in the request.
		expect(Object.keys(body.stills[0]!).sort()).toEqual([
			'height',
			'mimeType',
			'url',
			'width',
		])
		expect(String(init.body)).not.toContain('secret-token')
	})

	it('treats an error, a bad answer and an oversized answer as failures', async () => {
		const run = (response: () => Response) =>
			createHttpHeroVideoRenderer({
				...options,
				fetch: vi.fn(async () => response()) as never,
			}).render({ plan, stills })
		expect(await run(() => new Response('no', { status: 502 }))).toEqual({
			ok: false,
			error: 'renderer_failed',
		})
		expect(await run(() => new Response('not json'))).toEqual({
			ok: false,
			error: 'renderer_failed',
		})
		expect(await run(() => Response.json({ video: 1 }))).toEqual({
			ok: false,
			error: 'renderer_failed',
		})
		const tooBig = await run(() =>
			Response.json({
				video: 'A'.repeat(Math.ceil((HERO_VIDEO_MAX_BYTES * 4) / 3) + 100),
				poster: b64(new Uint8Array([1])),
			}),
		)
		expect(tooBig).toMatchObject({ ok: false })
		const throws = await createHttpHeroVideoRenderer({
			...options,
			fetch: vi.fn(async () => {
				throw new Error('down')
			}) as never,
		}).render({ plan, stills })
		expect(throws).toEqual({ ok: false, error: 'renderer_failed' })
	})
})

describe('limits and selection (#301)', () => {
	it('holds the clip and the poster to the size limits', () => {
		expect(
			checkRenderOutput({
				video: new Uint8Array(10),
				poster: new Uint8Array(10),
			}),
		).toBeNull()
		expect(
			checkRenderOutput({
				video: new Uint8Array(0),
				poster: new Uint8Array(10),
			}),
		).toBe('output_too_large')
		expect(
			checkRenderOutput({
				video: new Uint8Array(HERO_VIDEO_MAX_BYTES + 1),
				poster: new Uint8Array(10),
			}),
		).toBe('output_too_large')
		expect(
			checkRenderOutput({
				video: new Uint8Array(10),
				poster: new Uint8Array(HERO_VIDEO_POSTER_MAX_BYTES + 1),
			}),
		).toBe('output_too_large')
	})

	it('is not available without a renderer', () => {
		expect(getHeroVideoRenderer()).toBeNull()
	})

	it('never sends the token and the photo links over plain http', () => {
		vi.stubEnv('HERO_VIDEO_RENDERER_TOKEN', 'a-long-enough-token')
		try {
			vi.stubEnv(
				'HERO_VIDEO_RENDERER_URL',
				'http://renderer.example.com/render',
			)
			expect(getHeroVideoRenderer()).toBeNull()
			vi.stubEnv(
				'HERO_VIDEO_RENDERER_URL',
				'https://renderer.example.com/render',
			)
			expect(getHeroVideoRenderer()?.name).toBe('http')
			// A renderer on this machine may use http.
			vi.stubEnv('HERO_VIDEO_RENDERER_URL', 'http://localhost:4000/render')
			expect(getHeroVideoRenderer()?.name).toBe('http')
		} finally {
			vi.unstubAllEnvs()
		}
	})
})
