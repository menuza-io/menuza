import { google } from '@ai-sdk/google'
import { generateImage } from 'ai'

/** Nano Banana 2.1, Google's current image generation and editing model. */
export const DEFAULT_IMAGE_MODEL = 'gemini-nano-banana-2.1'

export const IMAGE_ASPECT_RATIOS = [
	'1:1',
	'2:3',
	'3:2',
	'3:4',
	'4:3',
	'4:5',
	'5:4',
	'9:16',
	'16:9',
	'21:9',
] as const

export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number]

export type ImageInput = {
	data: Uint8Array
	mediaType: string
}

export type EditImageOptions = {
	prompt: string
	/** Input images in the order the prompt refers to them. */
	images: ImageInput[]
	aspectRatio?: ImageAspectRatio
	imageSize?: '1K' | '2K' | '4K'
	modelName?: string
	abortSignal?: AbortSignal
}

export type EditImageResult = {
	data: Uint8Array
	mediaType: string
	model: string
}

/**
 * Generates one image from a text prompt and input images. Without input
 * images this is plain text-to-image generation.
 */
export async function editImage(
	options: EditImageOptions,
): Promise<EditImageResult> {
	const model = options.modelName ?? DEFAULT_IMAGE_MODEL
	const { image } = await generateImage({
		model: google.image(model),
		prompt: options.images.length
			? { text: options.prompt, images: options.images.map((i) => i.data) }
			: options.prompt,
		aspectRatio: options.aspectRatio,
		providerOptions: {
			google: { imageConfig: { imageSize: options.imageSize ?? '1K' } },
		},
		abortSignal: options.abortSignal,
		maxRetries: 1,
	})
	return {
		data: image.uint8Array,
		mediaType: image.mediaType || 'image/png',
		model,
	}
}
