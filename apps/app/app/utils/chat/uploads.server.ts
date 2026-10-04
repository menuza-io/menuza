import { type FileUpload } from '@mjackson/form-data-parser'
import { uploadChatImage as uploadChatImageToStorage } from '#app/utils/storage.server.ts'

export async function uploadChatImage(
	organizationId: string,
	userId: string,
	file: File | FileUpload,
) {
	return uploadChatImageToStorage(userId, organizationId, file)
}
