import {
	type Storyboard,
	HERO_VIDEO_MAX_BYTES,
	HERO_VIDEO_POSTER_MAX_BYTES,
} from '@repo/common/hero-video'
import { isLocalUrl } from '@repo/security/local-host'
import { readLiveEnv } from '#app/utils/env.server.ts'

/**
 * The renderer behind "Make a video from my photos" (#301). It is an adapter:
 * the App hands it the plan and the restaurant's own photos and gets back a
 * silent MP4 and a poster. Pan and zoom compositing of those stills only: there
 * is no generative model in the path, so nothing that is not the restaurant's
 * appears in the clip.
 *
 * - `http`: a renderer service the deployment runs (`HERO_VIDEO_RENDERER_URL`,
 *   bearer `HERO_VIDEO_RENDERER_TOKEN`). It reads each photo from a short-lived
 *   link, never the library.
 * - `mock`: a local emulator (`HERO_VIDEO_MOCK`, ignored unless BASE_URL is
 *   local) and the one tests use. It returns a tiny fixture clip and takes the
 *   poster from the first photo.
 *
 * A renderer answers within size limits that are checked here again.
 */

export type RendererStill = {
	/** A short-lived link to read the photo (never stored). */
	url: string
	mimeType: string
	width: number | null
	height: number | null
	/** The photo's bytes, for a renderer that works in process (the mock). */
	bytes?: Uint8Array
}

export type RenderInput = {
	plan: Storyboard
	stills: RendererStill[]
}

export type RenderOutput =
	| {
			ok: true
			video: Uint8Array
			videoMimeType: 'video/mp4' | 'video/webm'
			poster: Uint8Array
			posterMimeType: 'image/jpeg' | 'image/webp' | 'image/png'
	  }
	| { ok: false; error: 'renderer_failed' | 'output_too_large' }

export type HeroVideoRenderer = {
	name: 'http' | 'mock'
	render(input: RenderInput): Promise<RenderOutput>
}

/** True for `1`, `true`, `on`, `yes`, on a local deployment only. */
export function isHeroVideoMock(): boolean {
	return (
		['1', 'true', 'on', 'yes'].includes(
			readLiveEnv('HERO_VIDEO_MOCK').toLowerCase(),
		) && isLocalUrl(readLiveEnv('BASE_URL'))
	)
}

/** The renderer to use, or null when none is set up. */
export function getHeroVideoRenderer(): HeroVideoRenderer | null {
	if (isHeroVideoMock()) return createMockHeroVideoRenderer()
	const url = readLiveEnv('HERO_VIDEO_RENDERER_URL')
	const token = readLiveEnv('HERO_VIDEO_RENDERER_TOKEN')
	// The token and the photo links travel with the request: https only, except
	// for a renderer on this machine.
	if (!url || !token) return null
	if (!url.toLowerCase().startsWith('https://') && !isLocalUrl(url)) return null
	return createHttpHeroVideoRenderer({ url, token })
}

export function isHeroVideoRendererConfigured() {
	return getHeroVideoRenderer() !== null
}

/** Fits the limits the page relies on, whoever rendered it. */
export function checkRenderOutput(output: {
	video: Uint8Array
	poster: Uint8Array
}): 'output_too_large' | null {
	if (
		output.video.byteLength === 0 ||
		output.video.byteLength > HERO_VIDEO_MAX_BYTES ||
		output.poster.byteLength === 0 ||
		output.poster.byteLength > HERO_VIDEO_POSTER_MAX_BYTES
	) {
		return 'output_too_large'
	}
	return null
}

function fromBase64(value: string): Uint8Array {
	const binary = atob(value)
	const out = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
	return out
}

/** About 1.4 times the largest output, as base64 text. */
const MAX_RESPONSE_CHARS = Math.ceil(
	(HERO_VIDEO_MAX_BYTES + HERO_VIDEO_POSTER_MAX_BYTES) * 1.4,
)

export function createHttpHeroVideoRenderer(options: {
	url: string
	token: string
	fetch?: typeof fetch
	timeoutMs?: number
}): HeroVideoRenderer {
	const fetchFn = options.fetch ?? fetch
	return {
		name: 'http',
		async render(input) {
			try {
				const response = await fetchFn(options.url, {
					method: 'POST',
					redirect: 'manual',
					headers: {
						Authorization: `Bearer ${options.token}`,
						'Content-Type': 'application/json',
					},
					// The plan and short-lived photo links: no organization, no person.
					body: JSON.stringify({
						plan: input.plan,
						stills: input.stills.map((still) => ({
							url: still.url,
							mimeType: still.mimeType,
							width: still.width,
							height: still.height,
						})),
					}),
					signal: AbortSignal.timeout(options.timeoutMs ?? 240_000),
				})
				if (!response.ok) return { ok: false, error: 'renderer_failed' }
				const text = await response.text()
				if (text.length > MAX_RESPONSE_CHARS) {
					return { ok: false, error: 'output_too_large' }
				}
				const body = JSON.parse(text) as {
					video?: unknown
					poster?: unknown
					videoMimeType?: unknown
					posterMimeType?: unknown
				}
				if (typeof body.video !== 'string' || typeof body.poster !== 'string') {
					return { ok: false, error: 'renderer_failed' }
				}
				const videoMimeType =
					body.videoMimeType === 'video/webm' ? 'video/webm' : 'video/mp4'
				const posterMimeType =
					body.posterMimeType === 'image/webp'
						? 'image/webp'
						: body.posterMimeType === 'image/png'
							? 'image/png'
							: 'image/jpeg'
				const video = fromBase64(body.video)
				const poster = fromBase64(body.poster)
				const tooLarge = checkRenderOutput({ video, poster })
				if (tooLarge) return { ok: false, error: tooLarge }
				return { ok: true, video, videoMimeType, poster, posterMimeType }
			} catch {
				return { ok: false, error: 'renderer_failed' }
			}
		},
	}
}

/** A box of an MP4 file header, enough to be recognised as video/mp4 by sniffers. */
const MOCK_MP4 = new Uint8Array([
	0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00,
	0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
])

/**
 * A renderer that makes no video of its own: the clip is a fixture file and
 * the poster is the first of the restaurant's photos, exactly as bytes. It
 * records what it was asked, so tests can prove only the chosen photos went in.
 */
export function createMockHeroVideoRenderer(
	options: { fail?: boolean; tooLarge?: boolean } = {},
): HeroVideoRenderer & { calls: RenderInput[] } {
	const calls: RenderInput[] = []
	return {
		name: 'mock',
		calls,
		async render(input) {
			calls.push(input)
			if (options.fail) return { ok: false, error: 'renderer_failed' }
			const first = input.stills[0]
			if (!first?.bytes) return { ok: false, error: 'renderer_failed' }
			const video = options.tooLarge
				? new Uint8Array(HERO_VIDEO_MAX_BYTES + 1)
				: MOCK_MP4
			const output = { video, poster: first.bytes }
			const tooLarge = checkRenderOutput(output)
			if (tooLarge) return { ok: false, error: tooLarge }
			return {
				ok: true,
				video,
				videoMimeType: 'video/mp4',
				poster: first.bytes,
				posterMimeType:
					first.mimeType === 'image/png' ? 'image/png' : 'image/jpeg',
			}
		},
	}
}
