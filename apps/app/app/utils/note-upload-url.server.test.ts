import { describe, expect, it, vi, beforeEach } from 'vitest'
import type * as DatabaseModule from '@repo/database'
import {
	mockDb,
	mockSelectResults,
	resetMockDb,
} from '#tests/setup/drizzle-mock.ts'
import {
	enrichNoteUploadsWithImageSrc,
	enrichNotesListUploadsWithImageSrc,
} from './note-upload-url.server.ts'

vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof DatabaseModule>()
	const { mockDb, drizzleTable, drizzleOperator } =
		await import('#tests/setup/drizzle-mock.ts')
	return {
		...actual,
		db: mockDb,
		OrganizationMediaAsset: drizzleTable,
		and: drizzleOperator,
		eq: drizzleOperator,
		inArray: drizzleOperator,
	}
})

describe('enrichNoteUploadsWithImageSrc', () => {
	beforeEach(() => {
		resetMockDb()
	})

	it('uses mediaId URLs for registered library assets', async () => {
		mockSelectResults([
			{
				id: 'asset-1',
				objectKey: 'orgs/org-1/media/images/photo.webp',
				updatedAt: new Date('2026-01-01T00:00:00.000Z'),
			},
		])

		const uploads = await enrichNoteUploadsWithImageSrc(
			[
				{
					type: 'image',
					objectKey: 'orgs/org-1/media/images/photo.webp',
					altText: 'Photo',
				},
			],
			'org-1',
		)

		expect(uploads[0]?.imageSrc).toBe(
			'/resources/images?mediaId=asset-1&v=1767225600000',
		)
	})

	it('batch-enriches uploads for multiple notes with one asset query', async () => {
		mockSelectResults([
			{
				id: 'asset-1',
				objectKey: 'orgs/org-1/media/images/a.webp',
				updatedAt: new Date('2026-01-01T00:00:00.000Z'),
			},
			{
				id: 'asset-2',
				objectKey: 'orgs/org-1/media/images/b.webp',
				updatedAt: new Date('2026-01-02T00:00:00.000Z'),
			},
		])

		const notes = await enrichNotesListUploadsWithImageSrc(
			[
				{
					id: 'note-1',
					organizationNoteUploads: [
						{
							type: 'image',
							objectKey: 'orgs/org-1/media/images/a.webp',
						},
					],
				},
				{
					id: 'note-2',
					organizationNoteUploads: [
						{
							type: 'image',
							objectKey: 'orgs/org-1/media/images/b.webp',
						},
					],
				},
			],
			'org-1',
		)

		expect(mockDb.select).toHaveBeenCalledTimes(1)
		expect(notes[0]?.uploads[0]?.imageSrc).toContain('mediaId=asset-1')
		expect(notes[1]?.uploads[0]?.imageSrc).toContain('mediaId=asset-2')
	})

	it('splits media lookups to stay within the D1 parameter limit', async () => {
		mockSelectResults([], [])
		const organizationNoteUploads = Array.from({ length: 100 }, (_, index) => ({
			type: 'image',
			objectKey: `orgs/org-1/media/images/${index}.webp`,
		}))

		await enrichNotesListUploadsWithImageSrc(
			[{ id: 'note-1', organizationNoteUploads }],
			'org-1',
		)

		expect(mockDb.select).toHaveBeenCalledTimes(2)
	})

	it('falls back to object-key URLs when the asset lookup fails', async () => {
		mockDb.select.mockImplementationOnce(() => {
			throw new Error('database unavailable')
		})

		const uploads = await enrichNoteUploadsWithImageSrc(
			[
				{
					type: 'image',
					objectKey: 'orgs/org-1/media/images/photo.webp',
				},
			],
			'org-1',
		)

		expect(uploads[0]?.imageSrc).toContain(
			'objectKey=orgs%2Forg-1%2Fmedia%2Fimages%2Fphoto.webp',
		)
	})
})
