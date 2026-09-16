import {
	db,
	NoteComment,
	NoteCommentImage,
	OrganizationMediaAsset,
	OrganizationNote,
	OrganizationNoteUpload,
} from '@repo/database'
import { describe, expect, it } from 'vitest'

import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'
import { countOrgMediaObjectKeys } from './storage-migration.server.ts'

describe('countOrgMediaObjectKeys', () => {
	it('counts distinct media keys without loading the object list', async () => {
		const user = await createTestUser()
		const organization = await createTestOrganization(user.id, 'admin')
		const [note] = await db
			.insert(OrganizationNote)
			.values({
				title: 'Media note',
				content: 'Contains media',
				organizationId: organization.id,
				createdById: user.id,
			})
			.returning()

		await db.insert(OrganizationNoteUpload).values([
			{
				type: 'image',
				objectKey: 'media/photo.jpg',
				thumbnailKey: 'media/photo-thumb.jpg',
				noteId: note!.id,
			},
			{
				type: 'image',
				objectKey: 'media/photo.jpg',
				noteId: note!.id,
			},
		])
		const [comment] = await db
			.insert(NoteComment)
			.values({
				content: 'Media comment',
				noteId: note!.id,
				userId: user.id,
			})
			.returning()
		await db.insert(NoteCommentImage).values({
			objectKey: 'media/photo-thumb.jpg',
			commentId: comment!.id,
		})
		await db.insert(OrganizationMediaAsset).values({
			organizationId: organization.id,
			objectKey: 'media/library-image.png',
			mimeType: 'image/png',
			fileName: 'library-image.png',
			fileSize: 512,
			source: 'library',
			createdById: user.id,
		})

		await expect(countOrgMediaObjectKeys(organization.id)).resolves.toBe(3)
	})
})
