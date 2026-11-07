import {
	and,
	db,
	eq,
	NoteComment,
	NoteCommentImage,
	OrganizationMediaAsset,
	OrganizationNote,
	OrganizationNoteUpload,
	SocialPost,
	WebsitePage,
} from '@repo/database'
import type * as databaseModule from '@repo/database'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as noteMediaModule from '#app/utils/note-media-pipeline.server.ts'
import type * as storageModule from '#app/utils/storage.server.ts'
import { deleteOrganizationStorageObject } from '#app/utils/storage.server.ts'
import {
	createAuthenticatedRequest,
	createTestNote,
	getResponseStatus,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action as editorAction } from './__org-note-editor.server.tsx'
import { action as mediaAction } from './media.tsx'
import { action as noteAction } from './notes.$noteId.tsx'

const beforeTransaction = vi.hoisted(() => ({
	current: null as null | (() => Promise<void>),
}))
const afterMediaRead = vi.hoisted(() => ({
	current: null as null | (() => Promise<void>),
}))

// Lets a test run a write right after the note editor read the picked
// library items, before it checks them and saves.
vi.mock('#app/utils/note-media-pipeline.server.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof noteMediaModule>()
	return {
		...actual,
		processNoteMediaUploads: async (
			...args: Parameters<typeof actual.processNoteMediaUploads>
		) => {
			const result = await actual.processNoteMediaUploads(...args)
			const hook = afterMediaRead.current
			afterMediaRead.current = null
			if (hook) await hook()
			return result
		},
	}
})

// Lets a test run a write just before the next transaction starts. The
// database itself is real, but a transaction runs like on D1 (the Workers
// binding): a plain callback that a throw does not roll back.
vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof databaseModule>()
	const db = new Proxy(actual.db, {
		get(target, prop) {
			const value = Reflect.get(target, prop)
			if (prop !== 'transaction') return value
			return async (callback: (tx: typeof target) => unknown) => {
				const hook = beforeTransaction.current
				beforeTransaction.current = null
				if (hook) await hook()
				return callback(target)
			}
		},
	})
	return { ...actual, db }
})

// Storage is the external boundary; the database checks are real.
vi.mock('#app/utils/storage.server.ts', async (importOriginal) => ({
	...(await importOriginal<typeof storageModule>()),
	deleteOrganizationStorageObject: vi.fn().mockResolvedValue(undefined),
}))

afterEach(() => {
	vi.mocked(deleteOrganizationStorageObject).mockClear()
	beforeTransaction.current = null
	afterMediaRead.current = null
})

async function setup(source = 'library') {
	const { user, organization, cookie } = await setupTestOrgWithUser('admin')
	const objectKey = `orgs/${organization.id}/media/images/${Date.now()}-${Math.random()}.png`
	const [asset] = await db
		.insert(OrganizationMediaAsset)
		.values({
			organizationId: organization.id,
			objectKey,
			mimeType: 'image/png',
			source,
			createdById: user.id,
		})
		.returning()
	return { user, organization, cookie, asset: asset! }
}

async function deleteAsset(slug: string, cookie: string, id: string) {
	const body = new FormData()
	body.set('intent', 'delete')
	body.set('id', id)
	return (await mediaAction({
		request: createAuthenticatedRequest(
			`http://localhost:3000/${slug}/media`,
			{ method: 'POST', body },
			cookie,
		),
		params: { orgSlug: slug },
		context: {},
	} as never)) as Response
}

async function insertPage(
	organizationId: string,
	createdById: string,
	values: object,
) {
	await db.insert(WebsitePage).values({
		organizationId,
		createdById,
		title: 'Home',
		slug: `home-${Date.now()}-${Math.random()}`,
		...values,
	} as never)
}

describe('media library delete keeps objects that are still used', () => {
	it('keeps an object used only by a published page snapshot', async () => {
		const { user, organization, cookie, asset } = await setup()
		await insertPage(organization.id, user.id, {
			publishedData: JSON.stringify({ sections: [{ src: asset.objectKey }] }),
		})
		const res = await deleteAsset(organization.slug, cookie, asset.id)
		expect(res.status).toBe(200)
		expect(deleteOrganizationStorageObject).not.toHaveBeenCalled()
	})

	it('keeps an object used as a page SEO image (URL-encoded key)', async () => {
		const { user, organization, cookie, asset } = await setup()
		await insertPage(organization.id, user.id, {
			seoImageUrl: `/resources/images?objectKey=${encodeURIComponent(asset.objectKey)}`,
		})
		const res = await deleteAsset(organization.slug, cookie, asset.id)
		expect(res.status).toBe(200)
		expect(deleteOrganizationStorageObject).not.toHaveBeenCalled()
	})

	it('refuses to delete an image an unsent social post needs', async () => {
		const { organization, cookie, asset } = await setup()
		await db.insert(SocialPost).values({
			organizationId: organization.id,
			status: 'scheduled',
			media: [{ mediaId: asset.id, url: 'x', altText: null }],
		})
		const res = await deleteAsset(organization.slug, cookie, asset.id)
		expect(res.status).toBe(409)
		const rows = await db
			.select()
			.from(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.id, asset.id))
		expect(rows).toHaveLength(1)
		expect(deleteOrganizationStorageObject).not.toHaveBeenCalled()
	})

	it('keeps the file of a chat attachment', async () => {
		const { organization, cookie, asset } = await setup('chat')
		const res = await deleteAsset(organization.slug, cookie, asset.id)
		expect(res.status).toBe(200)
		expect(deleteOrganizationStorageObject).not.toHaveBeenCalled()
	})

	it('still deletes an unreferenced object', async () => {
		const { organization, cookie, asset } = await setup()
		const res = await deleteAsset(organization.slug, cookie, asset.id)
		expect(res.status).toBe(200)
		expect(deleteOrganizationStorageObject).toHaveBeenCalledWith(
			asset.objectKey,
			organization.id,
			'organization',
		)
	})
})

describe('attaching a library item races its deletion', () => {
	// Simulates the library delete landing between the attach's read of the
	// asset and its insert: the delete removes the row, finds no reference
	// yet and removes the object, so the insert must not land.
	function deleteAssetBeforeNextTransaction(assetId: string) {
		beforeTransaction.current = async () => {
			await db
				.delete(OrganizationMediaAsset)
				.where(eq(OrganizationMediaAsset.id, assetId))
		}
	}

	it('a comment does not keep a reference to a deleted library image', async () => {
		const { user, organization, cookie, asset } = await setup()
		const note = await createTestNote(organization.id, user.id)
		const formData = new FormData()
		formData.append('intent', 'add-comment')
		formData.append('noteId', note.id)
		formData.append('content', '')
		formData.append('libraryAssetCount', '1')
		formData.append('libraryAssetId-0', asset.id)
		deleteAssetBeforeNextTransaction(asset.id)

		const response = await noteAction({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/notes/${note.id}`,
				{ method: 'POST', body: formData },
				cookie,
			),
			params: { orgSlug: organization.slug, noteId: note.id },
			context: {},
		} as never)

		expect(getResponseStatus(response)).not.toBe(200)
		const images = await db
			.select()
			.from(NoteCommentImage)
			.where(eq(NoteCommentImage.objectKey, asset.objectKey))
		expect(images).toHaveLength(0)
		const comments = await db
			.select()
			.from(NoteComment)
			.where(eq(NoteComment.noteId, note.id))
		expect(comments).toHaveLength(0)
	})

	async function saveNewNote(
		organization: { slug: string },
		cookie: string,
		assetId: string,
	) {
		const formData = new FormData()
		formData.append('title', 'Launch plan')
		formData.append('content', 'Body')
		formData.append('images[0].mediaId', assetId)
		try {
			const response = await editorAction({
				request: createAuthenticatedRequest(
					`http://localhost:3000/${organization.slug}/notes/new`,
					{ method: 'POST', body: formData },
					cookie,
				),
				params: { orgSlug: organization.slug },
				context: {},
			} as never)
			return getResponseStatus(response)
		} catch (thrown) {
			return thrown instanceof Response ? thrown.status : 500
		}
	}

	async function savedNotes(organizationId: string) {
		return db
			.select({ id: OrganizationNote.id })
			.from(OrganizationNote)
			.where(
				and(
					eq(OrganizationNote.organizationId, organizationId),
					eq(OrganizationNote.title, 'Launch plan'),
				),
			)
	}

	it('a note is not saved when a picked library image was deleted before the save', async () => {
		const { organization, cookie, asset } = await setup()
		afterMediaRead.current = async () => {
			await db
				.delete(OrganizationMediaAsset)
				.where(eq(OrganizationMediaAsset.id, asset.id))
		}

		expect(await saveNewNote(organization, cookie, asset.id)).toBe(409)
		// Nothing was written: D1 cannot roll a half-done save back.
		expect(await savedNotes(organization.id)).toHaveLength(0)
		const uploads = await db
			.select()
			.from(OrganizationNoteUpload)
			.where(eq(OrganizationNoteUpload.objectKey, asset.objectKey))
		expect(uploads).toHaveLength(0)
	})

	it('a note does not keep a reference to a library image deleted while it is saved', async () => {
		const { organization, cookie, asset } = await setup()
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		// Onboarding tracking is not seeded in this database; it only logs.
		vi.spyOn(console, 'error').mockImplementation(() => {})
		deleteAssetBeforeNextTransaction(asset.id)

		// The note is saved without that one item instead of failing halfway.
		expect(await saveNewNote(organization, cookie, asset.id)).toBe(302)
		expect(await savedNotes(organization.id)).toHaveLength(1)
		expect(warn).toHaveBeenCalledOnce()
		const uploads = await db
			.select()
			.from(OrganizationNoteUpload)
			.where(eq(OrganizationNoteUpload.objectKey, asset.objectKey))
		expect(uploads).toHaveLength(0)
	})
})
