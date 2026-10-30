import { editImage, type ImageInput } from '@repo/ai/server'
import { detectRasterImage } from '@repo/storage'
import { withTimeout } from '#app/utils/phone-agent/faq-generate.server.ts'
import {
	checkRateLimit,
	type RateLimitConfig,
} from '#app/utils/rate-limit.server.ts'
import { getSignedGetRequestInfoAsync } from '#app/utils/storage.server.ts'
import { photoStudioVertical } from './photo-studio-vertical.ts'
import {
	buildPhotoStudioPrompt,
	resolvePhotoStudioOptions,
	type PhotoStudioAspectRatio,
	type PhotoStudioStyle,
} from './photo-studio.ts'

export const PHOTO_STUDIO_RATE_LIMIT: RateLimitConfig = {
	scope: 'media-photo-studio',
	maxRequests: process.env.NODE_ENV === 'development' ? 200 : 40,
	windowMs: 60 * 60 * 1000,
}

export const PHOTO_STUDIO_TIMEOUT_MS = 120_000
export const PHOTO_STUDIO_MAX_INPUT_BYTES = 10 * 1024 * 1024

/** Formats Gemini accepts as input images. */
const MODEL_INPUT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

export function isPhotoStudioConfigured() {
	return Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY)
}

export type PhotoStudioError =
	'rate_limited' | 'unavailable' | 'unsupported_image' | 'not_configured'

export class PhotoStudioInputError extends Error {}

/** Validates image bytes and returns them in a form the model accepts. */
export function toModelImage(buffer: ArrayBuffer): ImageInput {
	if (buffer.byteLength > PHOTO_STUDIO_MAX_INPUT_BYTES) {
		throw new PhotoStudioInputError('Image is too large.')
	}
	const detected = detectRasterImage(buffer)
	if (!detected || !MODEL_INPUT_TYPES.has(detected.mimeType)) {
		throw new PhotoStudioInputError('Unsupported image format.')
	}
	return { data: new Uint8Array(buffer), mediaType: detected.mimeType }
}

export async function readStoredMediaImage(asset: {
	objectKey: string
	storageScope: string
	organizationId: string
}): Promise<ImageInput> {
	const { url, headers } = await getSignedGetRequestInfoAsync(
		asset.objectKey,
		asset.storageScope === 'organization' ? asset.organizationId : undefined,
	)
	const response = await fetch(url, { headers })
	if (!response.ok) {
		throw new Error(`Could not read stored image (${response.status}).`)
	}
	return toModelImage(await response.arrayBuffer())
}

export type PhotoStudioRequest = {
	organizationId: string
	userId: string
	photo: ImageInput
	style: PhotoStudioStyle
	styleReference?: ImageInput
	previousResult?: ImageInput
	options: Record<string, unknown>
	instructions?: string
	aspectRatio: PhotoStudioAspectRatio
}

export type PhotoStudioResult =
	| {
			ok: true
			image: { base64: string; mimeType: string; width: number; height: number }
			model: string
	  }
	| { ok: false; error: PhotoStudioError }

/**
 * Restages one photo. Only the photo, an optional style reference, the
 * previous result while refining, and what the operator typed leave the app.
 * Nothing is stored here: the operator reviews the result and saves it.
 */
export async function generatePhotoStudioImage(
	input: PhotoStudioRequest,
	generate: typeof editImage = editImage,
): Promise<PhotoStudioResult> {
	if (!isPhotoStudioConfigured()) return { ok: false, error: 'not_configured' }
	const limit = await checkRateLimit(
		{ type: 'user', value: `${input.userId}:${input.organizationId}` },
		PHOTO_STUDIO_RATE_LIMIT,
	)
	if (!limit.allowed) return { ok: false, error: 'rate_limited' }

	const prompt = buildPhotoStudioPrompt({
		vertical: photoStudioVertical,
		style: input.style,
		options: resolvePhotoStudioOptions(photoStudioVertical, input.options),
		instructions: input.instructions,
		refining: Boolean(input.previousResult),
	})
	const images = [
		input.photo,
		...(input.style.type === 'reference' && input.styleReference
			? [input.styleReference]
			: []),
		...(input.previousResult ? [input.previousResult] : []),
	]

	try {
		const result = await withTimeout(
			generate({ prompt, images, aspectRatio: input.aspectRatio }),
			PHOTO_STUDIO_TIMEOUT_MS,
		)
		const bytes = result.data
		const detected = detectRasterImage(
			bytes.buffer.slice(
				bytes.byteOffset,
				bytes.byteOffset + bytes.byteLength,
			) as ArrayBuffer,
		)
		if (!detected) return { ok: false, error: 'unavailable' }
		return {
			ok: true,
			image: {
				base64: Buffer.from(bytes).toString('base64'),
				mimeType: detected.mimeType,
				width: detected.width,
				height: detected.height,
			},
			model: result.model,
		}
	} catch (error) {
		console.error('Photo studio generation failed:', error)
		return { ok: false, error: 'unavailable' }
	}
}
