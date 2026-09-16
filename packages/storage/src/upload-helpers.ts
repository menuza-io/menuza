import { type FileUpload } from '@mjackson/form-data-parser'
import { createId } from '@paralleldrive/cuid2'
import { type StorageConfig } from './types'
import { uploadToStorage } from './client'

/**
 * Upload options for organization-specific storage
 */
export interface UploadOptions {
	getConfig: (organizationId?: string) => Promise<StorageConfig>
}

/**
 * Sanitize and extract file extension safely
 * Prevents path traversal attacks and validates the filename
 */
function sanitizeAndExtractExtension(filename: string): string {
	// Remove path separators to prevent path traversal
	const basename = filename.replace(/^.*[\\/]/, '')
	// Remove null bytes (security: prevent null byte injection)
	// eslint-disable-next-line no-control-regex
	const cleaned = basename.replace(/\0/g, '')

	// Only the extension is used in the generated object key. The original
	// basename is deliberately discarded, so common characters such as
	// parentheses and non-Latin letters do not need to be rejected.
	const extensionSeparator = cleaned.lastIndexOf('.')
	if (extensionSeparator <= 0 || extensionSeparator === cleaned.length - 1) {
		return '' // No extension
	}

	const extension = cleaned.slice(extensionSeparator + 1).toLowerCase()

	// Validate extension against allowlist
	const allowedExtensions = [
		'jpg',
		'jpeg',
		'png',
		'gif',
		'webp',
		'mp4',
		'webm',
		'mov',
		'avi',
		'pdf',
		'txt',
		'avif',
		'woff2',
		'woff',
		'ttf',
		'otf',
	]

	if (!allowedExtensions.includes(extension)) {
		throw new Error(`File extension .${extension} is not allowed`)
	}

	return extension
}

/**
 * Upload a profile image for a user
 */
export async function uploadProfileImage(
	userId: string,
	file: File | FileUpload,
	options: UploadOptions,
	organizationId?: string,
) {
	const fileId = createId()
	const fileExtension = sanitizeAndExtractExtension(file.name)
	const timestamp = Date.now()
	const key = `users/${userId}/profile-images/${timestamp}-${fileId}.${fileExtension}`
	const config = await options.getConfig(organizationId)
	return uploadToStorage(file, key, config)
}

/**
 * Upload an organization logo image
 */
export async function uploadOrganizationImage(
	organizationId: string,
	file: File | FileUpload,
	options: UploadOptions,
) {
	const fileId = createId()
	const fileExtension = sanitizeAndExtractExtension(file.name)
	const timestamp = Date.now()
	const key = `org/${organizationId}/logo/${timestamp}-${fileId}.${fileExtension}`
	const config = await options.getConfig(organizationId)
	return uploadToStorage(file, key, config)
}

export type DetectedRasterFormat = {
	extension: 'jpg' | 'png' | 'gif' | 'webp' | 'avif'
	mimeType:
		'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'image/avif'
}

export function detectRasterImage(
	buffer: ArrayBuffer,
): DetectedRasterFormat | null {
	const bytes = new Uint8Array(buffer.slice(0, 16))
	if (bytes.length < 4) return null

	// JPEG: FF D8 FF
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return { extension: 'jpg', mimeType: 'image/jpeg' }
	}

	// PNG: 89 50 4E 47 0D 0A 1A 0A
	if (
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47
	) {
		return { extension: 'png', mimeType: 'image/png' }
	}

	// GIF: GIF87a or GIF89a (47 49 46 38)
	if (
		bytes[0] === 0x47 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x38
	) {
		return { extension: 'gif', mimeType: 'image/gif' }
	}

	// WebP: RIFF....WEBP (52 49 46 46 .... 57 45 42 50)
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return { extension: 'webp', mimeType: 'image/webp' }
	}

	// AVIF: ....ftypavif or ....ftypavis
	if (
		bytes.length >= 12 &&
		bytes[4] === 0x66 &&
		bytes[5] === 0x74 &&
		bytes[6] === 0x79 &&
		bytes[7] === 0x70
	) {
		const brand = String.fromCharCode(
			bytes[8] ?? 0,
			bytes[9] ?? 0,
			bytes[10] ?? 0,
			bytes[11] ?? 0,
		)
		if (brand === 'avif' || brand === 'avis') {
			return { extension: 'avif', mimeType: 'image/avif' }
		}
	}

	return null
}

export function isValidRasterBytes(buffer: ArrayBuffer): boolean {
	return detectRasterImage(buffer) !== null
}

export type UploadedMediaResult = {
	key: string
	mimeType: string
	extension: string
	file: File
}

/**
 * Upload an organization media image with raster validation
 */
export async function uploadOrganizationMediaImage(
	organizationId: string,
	file: File | FileUpload,
	options: UploadOptions,
): Promise<UploadedMediaResult> {
	const buffer = await file.arrayBuffer()
	const detected = detectRasterImage(buffer)
	if (!detected) {
		throw new Error(
			'Invalid image content: only JPEG, PNG, GIF, WebP, and AVIF are supported',
		)
	}

	const fileId = createId()
	const timestamp = Date.now()
	const key = `orgs/${organizationId}/media/images/${timestamp}-${fileId}.${detected.extension}`

	const sanitizedName = file.name
		? file.name.replace(/\0/g, '')
		: `image.${detected.extension}`
	const reconstructedFile = new File([buffer], sanitizedName, {
		type: detected.mimeType,
	})

	const config = await options.getConfig(organizationId)
	await uploadToStorage(reconstructedFile, key, config)

	return {
		key,
		mimeType: detected.mimeType,
		extension: detected.extension,
		file: reconstructedFile,
	}
}

/**
 * Upload a note image
 */
export async function uploadNoteImage(
	userId: string,
	noteId: string,
	file: File | FileUpload,
	options: UploadOptions,
	organizationId?: string,
) {
	if (!organizationId) {
		throw new Error('organizationId is required for note uploads')
	}

	const fileId = createId()
	const fileExtension = sanitizeAndExtractExtension(file.name)
	const timestamp = Date.now()
	const key = `orgs/${organizationId}/notes/${noteId}/images/${timestamp}-${fileId}.${fileExtension}`
	const config = await options.getConfig(organizationId)
	return uploadToStorage(file, key, config)
}

/**
 * Upload a comment image
 */
export async function uploadCommentImage(
	userId: string,
	commentId: string,
	file: File | FileUpload,
	options: UploadOptions,
	organizationId?: string,
) {
	if (!organizationId) {
		throw new Error('organizationId is required for comment uploads')
	}

	const fileId = createId()
	const fileExtension = sanitizeAndExtractExtension(file.name)
	const timestamp = Date.now()
	const key = `orgs/${organizationId}/comments/${commentId}/images/${timestamp}-${fileId}.${fileExtension}`
	const config = await options.getConfig(organizationId)
	return uploadToStorage(file, key, config)
}

/**
 * Upload a note video
 */
export async function uploadNoteVideo(
	userId: string,
	noteId: string,
	file: File | FileUpload,
	options: UploadOptions,
	organizationId?: string,
) {
	if (!organizationId) {
		throw new Error('organizationId is required for note video uploads')
	}

	const fileId = createId()
	const fileExtension = sanitizeAndExtractExtension(file.name)
	const timestamp = Date.now()
	const key = `orgs/${organizationId}/notes/${noteId}/videos/${timestamp}-${fileId}.${fileExtension}`
	const config = await options.getConfig(organizationId)
	return uploadToStorage(file, key, config)
}

/**
 * Upload a video thumbnail
 */
export async function uploadVideoThumbnail(
	userId: string,
	noteId: string,
	videoId: string,
	thumbnailBuffer: Buffer,
	options: UploadOptions,
	organizationId?: string,
) {
	if (!organizationId) {
		throw new Error('organizationId is required for video thumbnail uploads')
	}

	const fileId = createId()
	const timestamp = Date.now()
	const key = `orgs/${organizationId}/notes/${noteId}/videos/thumbnails/${timestamp}-${videoId}-${fileId}.jpg`

	// Create a File-like object from the buffer
	const thumbnailFile = new File(
		[new Uint8Array(thumbnailBuffer)],
		'thumbnail.jpg',
		{
			type: 'image/jpeg',
		},
	)

	const config = await options.getConfig(organizationId)
	return uploadToStorage(thumbnailFile, key, config)
}

/**
 * Upload a site icon image for an organization
 */
export async function uploadSiteIcon(
	organizationId: string,
	file: File | FileUpload,
	options: UploadOptions,
) {
	const fileId = createId()
	const fileExtension = sanitizeAndExtractExtension(file.name)
	const timestamp = Date.now()
	const key = `org/${organizationId}/site-icon/original/${timestamp}-${fileId}.${fileExtension}`
	const config = await options.getConfig(organizationId)
	return uploadToStorage(file, key, config)
}

/**
 * Upload an Open Graph / SEO social image for a website page
 */
export async function uploadWebsiteSeoImage(
	organizationId: string,
	pageId: string,
	file: File | FileUpload,
	options: UploadOptions,
) {
	const fileId = createId()
	const fileExtension = sanitizeAndExtractExtension(file.name)
	const timestamp = Date.now()
	const key = `org/${organizationId}/website/${pageId}/seo/${timestamp}-${fileId}.${fileExtension}`
	const config = await options.getConfig(organizationId)
	return uploadToStorage(file, key, config)
}

/**
 * Upload an asset for a website page block (image or video)
 */
export async function uploadWebsiteAsset(
	organizationId: string,
	pageId: string,
	file: File | FileUpload,
	options: UploadOptions,
) {
	const fileId = createId()
	const fileExtension = sanitizeAndExtractExtension(file.name)
	const timestamp = Date.now()
	const key = `org/${organizationId}/website/${pageId}/assets/${timestamp}-${fileId}.${fileExtension}`
	const config = await options.getConfig(organizationId)
	return uploadToStorage(file, key, config)
}

/**
 * Upload a custom heading or body font for an organization site.
 */
export async function uploadSiteFont(
	organizationId: string,
	role: 'heading' | 'body',
	file: File | FileUpload,
	options: UploadOptions,
) {
	const fileId = createId()
	const fileExtension = sanitizeAndExtractExtension(file.name)
	const timestamp = Date.now()
	const key = `org/${organizationId}/site-fonts/${role}/${timestamp}-${fileId}.${fileExtension}`
	const config = await options.getConfig(organizationId)
	return uploadToStorage(file, key, config)
}
