import { type editImage, type ImageInput } from '@repo/ai/server'
import { isLocalUrl } from '@repo/security/local-host'
import { detectRasterImage } from '@repo/storage'
import { readLiveEnv } from '#app/utils/env.server.ts'
import { restaurantDishPhotoStudio } from '../photo-studio-vertical.ts'
import {
	generatePhotoStudioImage,
	isPhotoStudioConfigured,
	type PhotoStudioError,
} from '../photo-studio.server.ts'
import {
	resolvePhotoStudioOptions,
	type PhotoStudioAspectRatio,
} from '../photo-studio.ts'

/**
 * The model behind "Restyle menu" (#146). An adapter: the service hands it one
 * dish photo and a studio preset and gets one restyled photo back. The real
 * adapter is the single-photo studio pipeline (`generatePhotoStudioImage`),
 * not a copy of it: same prompt builder, same model, plus the restaurant
 * vertical's food rule (only the plate, the backdrop and the light change).
 *
 * - `gemini`: the studio pipeline, needs `GOOGLE_GENERATIVE_AI_API_KEY`.
 * - `mock`: a local emulator (`MEDIA_RESTYLE_MOCK` or `MOCKS`, ignored unless
 *   `BASE_URL` is local). It returns a tiny fixture picture and records what it
 *   was asked.
 *
 * The photo is the only thing that leaves the App: no organization, no person.
 */

export type RestyleStyle = {
	presetId: string
	options: Record<string, boolean>
}

export type RestyleAdapterInput = {
	organizationId: string
	userId: string
	photo: ImageInput
	style: RestyleStyle
	aspectRatio: PhotoStudioAspectRatio
}

export type RestyleAdapterError = PhotoStudioError | 'unknown_preset'

export type RestyleAdapterResult =
	| {
			ok: true
			bytes: Uint8Array
			mimeType: string
			width: number
			height: number
			model: string
	  }
	| { ok: false; error: RestyleAdapterError }

export type RestyleAdapter = {
	name: 'gemini' | 'mock'
	restyle(input: RestyleAdapterInput): Promise<RestyleAdapterResult>
}

/** Errors that may pass: the item is tried again while attempts are left. */
export function isTransientRestyleError(error: RestyleAdapterError) {
	return error === 'rate_limited' || error === 'unavailable'
}

const ON = new Set(['1', 'true', 'on', 'yes'])

/** True for `1`, `true`, `on`, `yes` in `MEDIA_RESTYLE_MOCK` or `MOCKS`, on a local deployment only. */
export function isMediaRestyleMock(): boolean {
	const requested =
		ON.has(readLiveEnv('MEDIA_RESTYLE_MOCK').toLowerCase()) ||
		ON.has(readLiveEnv('MOCKS').toLowerCase())
	return requested && isLocalUrl(readLiveEnv('BASE_URL'))
}

/** The adapter to use, or null when none is set up. */
export function getRestyleAdapter(): RestyleAdapter | null {
	if (isMediaRestyleMock()) return createMockRestyleAdapter()
	if (!isPhotoStudioConfigured()) return null
	return createGeminiRestyleAdapter()
}

export function isMediaRestyleConfigured() {
	return getRestyleAdapter() !== null
}

function fromBase64(value: string): Uint8Array {
	const binary = atob(value)
	const out = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
	return out
}

export function createGeminiRestyleAdapter(
	generate?: typeof editImage,
): RestyleAdapter {
	return {
		name: 'gemini',
		async restyle(input) {
			const preset = restaurantDishPhotoStudio.presets.find(
				(candidate) => candidate.id === input.style.presetId,
			)
			if (!preset) return { ok: false, error: 'unknown_preset' }
			const result = await generatePhotoStudioImage(
				{
					organizationId: input.organizationId,
					userId: input.userId,
					photo: input.photo,
					style: { type: 'preset', preset },
					options: resolvePhotoStudioOptions(
						restaurantDishPhotoStudio,
						input.style.options,
					),
					aspectRatio: input.aspectRatio,
					vertical: restaurantDishPhotoStudio,
					// The run has its own daily budget; the studio's hourly limit
					// is for a person clicking.
					skipRateLimit: true,
				},
				generate,
			)
			if (!result.ok) return result
			return {
				ok: true,
				bytes: fromBase64(result.image.base64),
				mimeType: result.image.mimeType,
				width: result.image.width,
				height: result.image.height,
				model: result.model,
			}
		},
	}
}

/** A 1x1 PNG: a real raster picture the storage layer accepts. */
const MOCK_PNG = fromBase64(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
)

/**
 * An adapter that makes no picture of its own: the result is a fixture PNG,
 * the same for every photo, so a run's behaviour is deterministic. It records
 * what it was asked, so tests can prove only the photo and the style went in.
 */
export function createMockRestyleAdapter(
	options: {
		/** Fail every call with this error, or the Nth call (0-based) only. */
		fail?: RestyleAdapterError
		failOnCall?: number
		/** Answer something that is not a picture. */
		invalid?: boolean
	} = {},
): RestyleAdapter & { calls: RestyleAdapterInput[] } {
	const calls: RestyleAdapterInput[] = []
	return {
		name: 'mock',
		calls,
		async restyle(input) {
			const index = calls.length
			calls.push(input)
			if (
				options.fail &&
				(options.failOnCall === undefined || options.failOnCall === index)
			) {
				return { ok: false, error: options.fail }
			}
			if (options.invalid) {
				return {
					ok: true,
					bytes: new Uint8Array([1, 2, 3]),
					mimeType: 'image/png',
					width: 1,
					height: 1,
					model: 'mock',
				}
			}
			const detected = detectRasterImage(
				MOCK_PNG.buffer.slice(
					MOCK_PNG.byteOffset,
					MOCK_PNG.byteOffset + MOCK_PNG.byteLength,
				) as ArrayBuffer,
			)
			return {
				ok: true,
				bytes: MOCK_PNG,
				mimeType: detected?.mimeType ?? 'image/png',
				width: detected?.width ?? 1,
				height: detected?.height ?? 1,
				model: 'mock',
			}
		},
	}
}
