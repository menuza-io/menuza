/**
 * Images attached to a chat message. They travel inline as data URLs, so
 * nothing is stored: each is downsized first to keep the request small.
 */

export type ChatAttachment = {
	id: string
	name: string
	mediaType: string
	url: string
}

export const MAX_ATTACHMENTS = 4
export const ACCEPTED_IMAGE_TYPES = 'image/png,image/jpeg,image/webp,image/gif'

const MAX_SOURCE_BYTES = 10 * 1024 * 1024
// Kept under the server's 3,000,000 character cap, with room for the data URL
// prefix, so an image the client accepts is never refused after sending.
const MAX_URL_LENGTH = 2_400_000
// Tried in order until the encoded image fits: sharp first, then smaller.
const RESIZE_ATTEMPTS = [
	{ edge: 1600, quality: 0.85 },
	{ edge: 1600, quality: 0.7 },
	{ edge: 1280, quality: 0.7 },
	{ edge: 1024, quality: 0.6 },
	{ edge: 768, quality: 0.5 },
] as const
/** Images stay in the messages sent to the model for this many recent
 *  messages that carry them. Older ones go text-only, which bounds the request
 *  size and the token cost of a long conversation. */
export const IMAGE_HISTORY_MESSAGES = 2
/** Stands in for a message that was only an image once the image is left out,
 *  so the turn (and the reply to it) keeps its place in the history. */
export const OMITTED_IMAGE_TEXT = '[Image omitted]'

export function isAcceptedImage(file: File) {
	return ACCEPTED_IMAGE_TYPES.split(',').includes(file.type)
}

async function resizeToJpeg(file: File): Promise<string | null> {
	if (typeof createImageBitmap !== 'function') return null
	// Explicit, so a phone photo is not sent sideways in any browser.
	const bitmap = await createImageBitmap(file, {
		imageOrientation: 'from-image',
	})
	try {
		for (const { edge, quality } of RESIZE_ATTEMPTS) {
			const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height))
			const width = Math.max(1, Math.round(bitmap.width * scale))
			const height = Math.max(1, Math.round(bitmap.height * scale))
			const canvas = document.createElement('canvas')
			canvas.width = width
			canvas.height = height
			const context = canvas.getContext('2d')
			if (!context) return null
			// JPEG has no alpha, so transparent pixels would turn black.
			context.fillStyle = '#ffffff'
			context.fillRect(0, 0, width, height)
			context.drawImage(bitmap, 0, 0, width, height)
			const url = canvas.toDataURL('image/jpeg', quality)
			if (url.length <= MAX_URL_LENGTH) return url
		}
		// Even the smallest attempt did not fit.
		throw new Error('image too large')
	} finally {
		bitmap.close()
	}
}

/**
 * Returns null for a file that is not a usable image.
 *
 * Every image is decoded and re-encoded as a JPEG, which also drops its
 * metadata (EXIF, including GPS location) before it leaves for the model
 * provider. A browser that cannot decode it gets no attachment rather than
 * the original bytes. An animated GIF becomes its first frame.
 */
export async function fileToAttachment(
	file: File,
): Promise<ChatAttachment | null> {
	if (!isAcceptedImage(file) || file.size > MAX_SOURCE_BYTES) return null
	try {
		const url = await resizeToJpeg(file)
		if (!url) return null
		return {
			id: crypto.randomUUID(),
			name: file.name,
			mediaType: 'image/jpeg',
			url,
		}
	} catch {
		return null
	}
}

type WithParts = { parts: Array<{ type: string; text?: string }> }

/**
 * Returns the messages with images kept only on the last `keep` messages that
 * have any. A message left with nothing but the omitted image becomes a short
 * text placeholder, so every turn stays in the conversation. `keep = 0` strips
 * every image, for saving a conversation.
 */
export function keepRecentImages<T extends WithParts>(
	messages: T[],
	keep: number = IMAGE_HISTORY_MESSAGES,
): T[] {
	const hasImage = (message: T) =>
		message.parts.some((part) => part.type === 'file')
	const kept = new Set<number>()
	for (
		let index = messages.length - 1;
		index >= 0 && kept.size < keep;
		index--
	) {
		const message = messages[index]
		if (message && hasImage(message)) kept.add(index)
	}
	return messages.map((message, index) => {
		if (!hasImage(message) || kept.has(index)) return message
		const parts = message.parts.filter((part) => part.type !== 'file')
		return {
			...message,
			parts:
				parts.length > 0
					? parts
					: ([{ type: 'text', text: OMITTED_IMAGE_TEXT }] as typeof parts),
		}
	})
}
