import {
	db,
	OrganizationMediaAsset,
	OrganizationNoteUpload,
	OrganizationRole,
	_OrganizationPermissionToRole,
} from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import type * as photoStudioModule from '#app/utils/media/photo-studio.server.ts'
import { generatePhotoStudioImage } from '#app/utils/media/photo-studio.server.ts'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestNote,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action, loader } from './media.tsx'
import { action as studioAction } from './media_.studio.tsx'

// The model is the external boundary; the permission checks are real.
vi.mock('#app/utils/media/photo-studio.server.ts', async (importOriginal) => ({
	...(await importOriginal<typeof photoStudioModule>()),
	isPhotoStudioConfigured: () => true,
	generatePhotoStudioImage: vi.fn(),
}))

async function setup() {
	const { user: admin, organization } = await setupTestOrgWithUser('admin')
	const objectKey = `orgs/${organization.id}/media/test-${Date.now()}.png`
	const [asset] = await db
		.insert(OrganizationMediaAsset)
		.values({
			organizationId: organization.id,
			objectKey,
			mimeType: 'image/png',
		})
		.returning()
	const privateNote = await createTestNote(organization.id, admin.id, {
		title: 'Private launch plan',
		isPublic: false,
	})
	const publicNote = await createTestNote(organization.id, admin.id, {
		title: 'Public brand guide',
		isPublic: true,
	})
	for (const note of [privateNote, publicNote]) {
		await db
			.insert(OrganizationNoteUpload)
			.values({ noteId: note.id, type: 'image', objectKey })
	}
	return { organization, asset: asset! }
}

async function as(organizationId: string, role: string) {
	const user = await createTestUser()
	await addOrganizationMember(user.id, organizationId, role)
	return (await createTestSession(user.id)).cookie
}

/** An organization-scoped custom role with the given permission ids. */
async function customRole(organizationId: string, permissionIds: string[]) {
	const [role] = await db
		.insert(OrganizationRole)
		.values({
			name: `Custom ${crypto.randomUUID().slice(0, 8)}`,
			description: '',
			level: 0,
			organizationId,
		})
		.returning({ id: OrganizationRole.id })
	await db
		.insert(_OrganizationPermissionToRole)
		.values(permissionIds.map((B) => ({ A: role!.id, B })))
	return role!.id
}

async function loadMedia(slug: string, cookie: string) {
	return loader({
		request: createAuthenticatedRequest(
			`http://localhost:3000/${slug}/media`,
			{},
			cookie,
		),
		params: { orgSlug: slug },
		context: {},
	} as never)
}

async function post(
	slug: string,
	cookie: string,
	fields: Record<string, string>,
) {
	const body = new FormData()
	for (const [key, value] of Object.entries(fields)) body.set(key, value)
	try {
		return (await action({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${slug}/media`,
				{ method: 'POST', body },
				cookie,
			),
			params: { orgSlug: slug },
			context: {},
		} as never)) as Response
	} catch (thrown) {
		if (thrown instanceof Response) return thrown
		throw thrown
	}
}

describe('media library permissions', () => {
	it.each(['org_role_viewer', 'org_role_guest'])(
		'%s cannot rename or delete shared media',
		async (role) => {
			const { organization, asset } = await setup()
			const cookie = await as(organization.id, role)
			const rename = await post(organization.slug, cookie, {
				intent: 'update',
				id: asset.id,
				fileName: 'hijacked.png',
				altText: '',
				caption: '',
			})
			expect(rename.status).toBe(403)
			const remove = await post(organization.slug, cookie, {
				intent: 'delete',
				id: asset.id,
			})
			expect(remove.status).toBe(403)
		},
	)

	it('a member can still rename media', async () => {
		const { organization, asset } = await setup()
		const cookie = await as(organization.id, 'org_role_member')
		const res = await post(organization.slug, cookie, {
			intent: 'update',
			id: asset.id,
			fileName: 'renamed.png',
			altText: '',
			caption: '',
		})
		expect(res.status).toBe(200)
	})

	it('the loader tells the page who may manage media', async () => {
		const { organization } = await setup()
		for (const [role, expected] of [
			['org_role_viewer', false],
			['org_role_member', true],
		] as const) {
			const cookie = await as(organization.id, role)
			const data = await loader({
				request: createAuthenticatedRequest(
					`http://localhost:3000/${organization.slug}/media`,
					{},
					cookie,
				),
				params: { orgSlug: organization.slug },
				context: {},
			} as never)
			expect({ role, canManage: data.canManageMedia }).toEqual({
				role,
				canManage: expected,
			})
		}
	})

	describe('AI photo studio', () => {
		// The studio saves through /media, which needs update:media:any, so the
		// studio permission alone would spend credits on images it cannot keep.
		it('needs permission to manage media as well as to use the studio', async () => {
			const { organization, asset } = await setup()
			const studioOnly = await as(
				organization.id,
				await customRole(organization.id, ['org_perm_create_media_studio_any']),
			)
			expect(
				(await loadMedia(organization.slug, studioOnly)).photoStudioEnabled,
			).toBe(false)

			const body = new FormData()
			body.set('assetId', asset.id)
			body.set('styleType', 'reference')
			body.set('aspectRatio', '1:1')
			const res = await studioAction({
				request: createAuthenticatedRequest(
					`http://localhost:3000/${organization.slug}/media/studio`,
					{ method: 'POST', body },
					studioOnly,
				),
				params: { orgSlug: organization.slug },
				context: {},
			} as never).catch((thrown: unknown) => thrown as Response)
			expect((res as Response).status).toBe(403)
			expect(generatePhotoStudioImage).not.toHaveBeenCalled()
		})

		it('is offered to a role with both permissions', async () => {
			const { organization } = await setup()
			const both = await as(
				organization.id,
				await customRole(organization.id, [
					'org_perm_create_media_studio_any',
					'org_perm_update_media_any',
				]),
			)
			expect(
				(await loadMedia(organization.slug, both)).photoStudioEnabled,
			).toBe(true)
		})
	})

	it('"where is this used" lists only notes the member can open', async () => {
		const { organization, asset } = await setup()
		const cookie = await as(organization.id, 'org_role_viewer')
		const res = await post(organization.slug, cookie, {
			intent: 'get-references',
			id: asset.id,
		})
		expect(res.status).toBe(200)
		const { references } = (await res.json()) as {
			references: { title: string }[]
		}
		const titles = references.map((ref) => ref.title)
		expect(titles).toContain('Public brand guide')
		expect(titles).not.toContain('Private launch plan')
	})
})
