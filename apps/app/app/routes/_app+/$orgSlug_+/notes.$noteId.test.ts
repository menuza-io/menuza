import {
	and,
	db,
	eq,
	NoteComment,
	NoteCommentImage,
	OrganizationMediaAsset,
	OrganizationNote,
	OrganizationNoteFavorite,
	UserOrganization,
} from '@repo/database'
import { describe, expect, it } from 'vitest'
import {
	createAuthenticatedRequest,
	createTestNote,
	createTestOrganization,
	createTestSession,
	createTestUser,
	getResponseStatus,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action, loader } from './notes.$noteId.tsx'

describe('notes.$noteId route integration', () => {
	describe('loader', () => {
		it('returns 404 when note does not exist', async () => {
			const { organization, cookie } = await setupTestOrgWithUser('admin')

			const request = createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/notes/nonexistent-id`,
				{},
				cookie,
			)

			try {
				await loader({
					request,
					params: { orgSlug: organization.slug, noteId: 'nonexistent-id' },
					context: {},
				} as any)
				expect.fail('Expected loader to throw 404 for nonexistent note')
			} catch (error: any) {
				expect(error).toBeInstanceOf(Response)
				expect(error.status).toBe(404)
			}
		})

		it('loads note details for authorized organization member', async () => {
			const { user, organization, cookie } =
				await setupTestOrgWithUser('member')
			const note = await createTestNote(organization.id, user.id, {
				title: 'Meeting Notes',
				content: 'Discussion points for sprint planning',
				isPublic: true,
			})

			const request = createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/notes/${note.id}`,
				{},
				cookie,
			)

			const result = (await loader({
				request,
				params: { orgSlug: organization.slug, noteId: note.id },
				context: {},
			} as any)) as any

			expect(result).toBeDefined()
			expect(result.note).toBeDefined()
			expect(result.note.id).toBe(note.id)
			expect(result.note.title).toBe('Meeting Notes')
			expect(result.note.content).toBe('Discussion points for sprint planning')
		})

		it('denies access to non-organization members', async () => {
			const { user, organization } = await setupTestOrgWithUser('admin')
			const note = await createTestNote(organization.id, user.id, {
				title: 'Confidential Strategy',
			})

			// Create another user from outside the organization
			const outsider = await createTestUser()
			const { cookie: outsiderCookie } = await createTestSession(outsider.id)

			const request = createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/notes/${note.id}`,
				{},
				outsiderCookie,
			)

			try {
				await loader({
					request,
					params: { orgSlug: organization.slug, noteId: note.id },
					context: {},
				} as any)
				expect.fail('Expected loader to deny outsider')
			} catch (error: any) {
				expect(error).toBeInstanceOf(Response)
				expect([403, 404]).toContain(error.status)
			}
		})

		it('denies access to private note when member is not owner and lacks org-wide permission', async () => {
			const { user: owner, organization } = await setupTestOrgWithUser('admin')
			const privateNote = await createTestNote(organization.id, owner.id, {
				title: 'Private Note',
				isPublic: false,
			})

			// Create a guest user (role guest lacks read:note:org)
			const guestUser = await createTestUser()
			await db.insert(UserOrganization).values({
				userId: guestUser.id,
				organizationId: organization.id,
				organizationRoleId: 'org_role_guest',
				active: true,
			})
			const { cookie: guestCookie } = await createTestSession(guestUser.id)

			const request = createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/notes/${privateNote.id}`,
				{},
				guestCookie,
			)

			try {
				await loader({
					request,
					params: { orgSlug: organization.slug, noteId: privateNote.id },
					context: {},
				} as any)
				expect.fail('Expected loader to deny guest access to private note')
			} catch (error: any) {
				expect(error).toBeInstanceOf(Response)
				expect(error.status).toBe(403)
			}
		})
	})

	describe('action', () => {
		it('creates an attachment-only comment from an organization library asset', async () => {
			const { user, organization, cookie } =
				await setupTestOrgWithUser('member')
			const note = await createTestNote(organization.id, user.id)
			const [asset] = await db
				.insert(OrganizationMediaAsset)
				.values({
					organizationId: organization.id,
					objectKey: `orgs/${organization.id}/media/images/comment.png`,
					mimeType: 'image/png',
					fileName: 'comment.png',
					fileSize: 128,
					source: 'library',
					createdById: user.id,
				})
				.returning()

			const formData = new FormData()
			formData.append('intent', 'add-comment')
			formData.append('noteId', note.id)
			formData.append('content', '')
			formData.append('libraryAssetCount', '1')
			formData.append('libraryAssetId-0', asset!.id)

			const request = createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/notes/${note.id}`,
				{ method: 'POST', body: formData },
				cookie,
			)
			const response = await action({
				request,
				params: { orgSlug: organization.slug, noteId: note.id },
				context: {},
			} as any)

			expect(getResponseStatus(response)).toBe(200)
			const [comment] = await db
				.select()
				.from(NoteComment)
				.where(eq(NoteComment.noteId, note.id))
				.limit(1)
			expect(comment?.content).toBe('')
			const [image] = await db
				.select()
				.from(NoteCommentImage)
				.where(eq(NoteCommentImage.commentId, comment!.id))
				.limit(1)
			expect(image?.objectKey).toBe(asset!.objectKey)
		})

		it('rejects an attachment-only comment that references another organization asset', async () => {
			const { user, organization, cookie } =
				await setupTestOrgWithUser('member')
			const otherOrganization = await createTestOrganization(user.id, 'admin')
			const note = await createTestNote(organization.id, user.id)
			const [asset] = await db
				.insert(OrganizationMediaAsset)
				.values({
					organizationId: otherOrganization.id,
					objectKey: `orgs/${otherOrganization.id}/media/images/private.png`,
					mimeType: 'image/png',
					fileName: 'private.png',
					fileSize: 128,
					source: 'library',
					createdById: user.id,
				})
				.returning()

			const formData = new FormData()
			formData.append('intent', 'add-comment')
			formData.append('noteId', note.id)
			formData.append('content', '')
			formData.append('libraryAssetCount', '1')
			formData.append('libraryAssetId-0', asset!.id)

			const request = createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/notes/${note.id}`,
				{ method: 'POST', body: formData },
				cookie,
			)
			const response = await action({
				request,
				params: { orgSlug: organization.slug, noteId: note.id },
				context: {},
			} as any)

			expect(getResponseStatus(response)).toBe(400)
			const comments = await db
				.select()
				.from(NoteComment)
				.where(eq(NoteComment.noteId, note.id))
			expect(comments).toHaveLength(0)
		})

		it('toggles favorite on a note', async () => {
			const { user, organization, cookie } =
				await setupTestOrgWithUser('member')
			const note = await createTestNote(organization.id, user.id)

			const formData = new FormData()
			formData.append('intent', 'toggle-favorite')
			formData.append('noteId', note.id)

			const request = createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/notes/${note.id}`,
				{ method: 'POST', body: formData },
				cookie,
			)

			const response = await action({
				request,
				params: { orgSlug: organization.slug, noteId: note.id },
				context: {},
			} as any)

			expect(getResponseStatus(response)).toBe(200)

			// Verify favorite created in DB
			const [fav] = await db
				.select()
				.from(OrganizationNoteFavorite)
				.where(
					and(
						eq(OrganizationNoteFavorite.noteId, note.id),
						eq(OrganizationNoteFavorite.userId, user.id),
					),
				)
				.limit(1)

			expect(fav).toBeDefined()

			// Toggle again to remove favorite
			const formData2 = new FormData()
			formData2.append('intent', 'toggle-favorite')
			formData2.append('noteId', note.id)

			const request2 = createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/notes/${note.id}`,
				{ method: 'POST', body: formData2 },
				cookie,
			)

			const response2 = await action({
				request: request2,
				params: { orgSlug: organization.slug, noteId: note.id },
				context: {},
			} as any)

			expect(getResponseStatus(response2)).toBe(200)

			const [favAfter] = await db
				.select()
				.from(OrganizationNoteFavorite)
				.where(
					and(
						eq(OrganizationNoteFavorite.noteId, note.id),
						eq(OrganizationNoteFavorite.userId, user.id),
					),
				)
				.limit(1)

			expect(favAfter).toBeUndefined()
		})

		it('allows owner to delete note and redirects to notes list', async () => {
			const { user, organization, cookie } =
				await setupTestOrgWithUser('member')
			const note = await createTestNote(organization.id, user.id)

			const formData = new FormData()
			formData.append('intent', 'delete-note')
			formData.append('noteId', note.id)

			const request = createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/notes/${note.id}`,
				{ method: 'POST', body: formData },
				cookie,
			)

			let response: Response
			try {
				response = (await action({
					request,
					params: { orgSlug: organization.slug, noteId: note.id },
					context: {},
				} as any)) as Response
			} catch (thrown: any) {
				if (thrown instanceof Response) {
					response = thrown
				} else {
					throw thrown
				}
			}

			expect(response.status).toBe(302)
			expect(response.headers.get('Location')).toBe(
				`/${organization.slug}/notes`,
			)

			// Verify note was deleted from SQLite database
			const [dbNote] = await db
				.select()
				.from(OrganizationNote)
				.where(eq(OrganizationNote.id, note.id))
				.limit(1)

			expect(dbNote).toBeUndefined()
		})
	})
})
