import { getNoteImgSrc } from '@repo/common'
import { and, db, eq, inArray, OrganizationMediaAsset } from '@repo/database'

export function getOrganizationMediaImageUrl(
	assetId: string,
	updatedAt: Date | number,
) {
	const version =
		typeof updatedAt === 'number' ? updatedAt : updatedAt.getTime()
	return `/resources/images?mediaId=${encodeURIComponent(assetId)}&v=${version}`
}

type NoteUploadRow = {
	type: string
	objectKey: string
	altText?: string | null
	id?: string
}

type MediaAssetRow = {
	id: string
	objectKey: string
	updatedAt: Date
}

const MAX_OBJECT_KEYS_PER_QUERY = 99

async function loadMediaAssetsByObjectKeys(
	organizationId: string,
	objectKeys: string[],
): Promise<Map<string, MediaAssetRow>> {
	if (objectKeys.length === 0) {
		return new Map()
	}

	const assets: MediaAssetRow[] = []
	try {
		for (
			let offset = 0;
			offset < objectKeys.length;
			offset += MAX_OBJECT_KEYS_PER_QUERY
		) {
			const keys = objectKeys.slice(offset, offset + MAX_OBJECT_KEYS_PER_QUERY)
			const batch = await db
				.select({
					id: OrganizationMediaAsset.id,
					objectKey: OrganizationMediaAsset.objectKey,
					updatedAt: OrganizationMediaAsset.updatedAt,
				})
				.from(OrganizationMediaAsset)
				.where(
					and(
						eq(OrganizationMediaAsset.organizationId, organizationId),
						inArray(OrganizationMediaAsset.objectKey, keys),
					),
				)
			assets.push(...batch)
		}
	} catch {
		return new Map()
	}

	return new Map(assets.map((asset) => [asset.objectKey, asset] as const))
}

function attachImageSrcToUploads<T extends NoteUploadRow>(
	uploads: T[],
	organizationId: string,
	assetByObjectKey: Map<string, MediaAssetRow>,
): Array<T & { imageSrc: string }> {
	return uploads.map((upload) => {
		if (upload.type !== 'image') {
			return {
				...upload,
				imageSrc: getNoteImgSrc(upload.objectKey, organizationId),
			}
		}

		const asset = assetByObjectKey.get(upload.objectKey)
		return {
			...upload,
			imageSrc: asset
				? getOrganizationMediaImageUrl(asset.id, asset.updatedAt)
				: getNoteImgSrc(upload.objectKey, organizationId),
		}
	})
}

export async function enrichNoteUploadsWithImageSrc<T extends NoteUploadRow>(
	uploads: T[],
	organizationId: string,
): Promise<Array<T & { imageSrc: string }>> {
	const imageKeys = [
		...new Set(
			uploads
				.filter((upload) => upload.type === 'image')
				.map((u) => u.objectKey),
		),
	]

	const assetByObjectKey = await loadMediaAssetsByObjectKeys(
		organizationId,
		imageKeys,
	)

	return attachImageSrcToUploads(uploads, organizationId, assetByObjectKey)
}

export async function enrichNotesListUploadsWithImageSrc<
	T extends { organizationNoteUploads: NoteUploadRow[] },
>(
	notes: T[],
	organizationId: string,
): Promise<
	Array<
		Omit<T, 'organizationNoteUploads'> & {
			uploads: Array<
				T['organizationNoteUploads'][number] & { imageSrc: string }
			>
		}
	>
> {
	const imageKeys = [
		...new Set(
			notes.flatMap((note) =>
				note.organizationNoteUploads
					.filter((upload) => upload.type === 'image')
					.map((upload) => upload.objectKey),
			),
		),
	]

	const assetByObjectKey = await loadMediaAssetsByObjectKeys(
		organizationId,
		imageKeys,
	)

	return notes.map((note) => {
		const { organizationNoteUploads, ...rest } = note
		return {
			...rest,
			uploads: attachImageSrcToUploads(
				organizationNoteUploads,
				organizationId,
				assetByObjectKey,
			),
		}
	})
}
