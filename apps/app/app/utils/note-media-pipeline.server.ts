import { and, db, eq, OrganizationMediaAsset } from '@repo/database'
import {
	type ImageFieldset,
	type MediaFieldset,
} from '#app/routes/_app+/$orgSlug_+/__org-note-editor.tsx'
import { uploadNoteImage, uploadNoteVideo } from '#app/utils/storage.server.ts'

type UploadFieldset = (ImageFieldset | MediaFieldset) & { type?: string }

function uploadHasId(
	upload: UploadFieldset,
): upload is UploadFieldset & { id: string } {
	return typeof upload.id === 'string' && upload.id.length > 0
}

function uploadHasFile(
	upload: UploadFieldset,
): upload is UploadFieldset & { file: File } {
	return Boolean(upload.file?.size && upload.file?.size > 0)
}

function uploadHasMediaId(
	upload: UploadFieldset,
): upload is UploadFieldset & { mediaId: string } {
	return typeof upload.mediaId === 'string' && upload.mediaId.length > 0
}

export interface PreparedUploads {
	uploadUpdates: Array<{
		id: string
		type?: string
		altText?: string
		objectKey?: string
		mimeType?: string
		fileSize?: number
		status?: string
	}>
	newUploads: Array<{
		type: string
		altText?: string
		objectKey: string
		mimeType?: string
		fileSize?: number
		status: string
	}>
}

export async function processNoteMediaUploads(
	userId: string,
	noteId: string,
	organizationId: string,
	images: ImageFieldset[] = [],
	media: MediaFieldset[] = [],
): Promise<PreparedUploads> {
	const allUploads: UploadFieldset[] = [
		...images.map((img) => ({ ...img, type: 'image' })),
		...media.map((m) => ({
			...m,
			type: m.type || (m.file?.type?.startsWith('video/') ? 'video' : 'image'),
		})),
	]

	const uploadUpdates = await Promise.all(
		allUploads.filter(uploadHasId).map(async (upload) => {
			if (uploadHasFile(upload)) {
				const isVideo =
					upload.type === 'video' || upload.file?.type?.startsWith('video/')
				const objectKey = isVideo
					? await uploadNoteVideo(userId, noteId, upload.file, organizationId)
					: await uploadNoteImage(userId, noteId, upload.file, organizationId)

				return {
					id: upload.id,
					type: isVideo ? 'video' : 'image',
					altText: upload.altText,
					objectKey,
					mimeType: upload.file?.type,
					fileSize: upload.file?.size,
					status: 'completed',
				}
			} else {
				return {
					id: upload.id,
					altText: upload.altText,
				}
			}
		}),
	)

	const newUploads = await Promise.all(
		allUploads
			.filter((upload) => !upload.id)
			.map(async (upload) => {
				if (uploadHasMediaId(upload) && !uploadHasFile(upload)) {
					const [asset] = await db
						.select({
							objectKey: OrganizationMediaAsset.objectKey,
							mimeType: OrganizationMediaAsset.mimeType,
							fileSize: OrganizationMediaAsset.fileSize,
							altText: OrganizationMediaAsset.altText,
						})
						.from(OrganizationMediaAsset)
						.where(
							and(
								eq(OrganizationMediaAsset.id, upload.mediaId),
								eq(OrganizationMediaAsset.organizationId, organizationId),
							),
						)
						.limit(1)

					if (!asset || !asset.mimeType.startsWith('image/')) {
						throw new Error(
							'Selected media is not available in this organization',
						)
					}

					return {
						type: 'image',
						altText: upload.altText || asset.altText || undefined,
						objectKey: asset.objectKey,
						mimeType: asset.mimeType,
						fileSize: asset.fileSize ?? undefined,
						status: 'completed',
					}
				}

				if (!uploadHasFile(upload)) {
					throw new Error('A file or media library image is required')
				}

				const isVideo =
					upload.type === 'video' || upload.file?.type?.startsWith('video/')
				const objectKey = isVideo
					? await uploadNoteVideo(userId, noteId, upload.file, organizationId)
					: await uploadNoteImage(userId, noteId, upload.file, organizationId)

				return {
					type: isVideo ? 'video' : 'image',
					altText: upload.altText,
					objectKey,
					mimeType: upload.file?.type,
					fileSize: upload.file?.size,
					status: 'completed',
				}
			}),
	)

	return { uploadUpdates, newUploads }
}
