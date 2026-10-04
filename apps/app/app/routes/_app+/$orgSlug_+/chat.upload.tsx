import { parseFormData, type FileUpload } from '@mjackson/form-data-parser'
import { requireUserId } from '@repo/auth'
import { type ActionFunctionArgs } from 'react-router'
import { uploadChatImage } from '#app/utils/chat/uploads.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024

function asImageUpload(file: unknown): File | FileUpload | null {
	if (file instanceof File && file.size > 0) return file
	if (
		file &&
		typeof file === 'object' &&
		'name' in file &&
		'type' in file &&
		'size' in file &&
		typeof (file as FileUpload).arrayBuffer === 'function' &&
		(file as FileUpload).size > 0
	) {
		return file as FileUpload
	}
	return null
}

function friendlyUploadError(error: unknown): string {
	if (error instanceof Error) {
		const message = error.message
		if (/internal error/i.test(message)) {
			return 'Image storage is unavailable in dev. Ensure MOCKS=true and restart the app dev server.'
		}
		if (/Failed to upload object/i.test(message)) {
			return 'Could not save the image. Check storage configuration or try a smaller file.'
		}
		if (/Invalid image content/i.test(message)) {
			return 'Use a JPEG, PNG, GIF, WebP, or AVIF image.'
		}
		return message
	}
	return 'Could not upload that image.'
}

export async function action({ request, params }: ActionFunctionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(
		request,
		params.orgSlug || '',
		{ id: true },
	)

	let form: FormData
	try {
		form = await parseFormData(request, {
			maxFileSize: MAX_CHAT_IMAGE_BYTES,
		})
	} catch {
		return {
			ok: false as const,
			error: 'Images must be 10 MB or smaller.',
		}
	}

	const file = asImageUpload(form.get('file'))
	if (!file) {
		return { ok: false as const, error: 'Choose an image to upload.' }
	}
	const mime =
		file instanceof File ? file.type : (file as FileUpload).type || ''
	if (!mime.startsWith('image/')) {
		return { ok: false as const, error: 'Only images are supported in chat.' }
	}

	try {
		const objectKey = await uploadChatImage(organization.id, userId, file)
		return { ok: true as const, objectKey }
	} catch (error) {
		console.error('chat.upload failed', error)
		return {
			ok: false as const,
			error: friendlyUploadError(error),
		}
	}
}
