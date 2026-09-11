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
