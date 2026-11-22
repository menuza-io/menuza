import { db, OrganizationMediaAsset } from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import type * as storageModule from '#app/utils/storage.server.ts'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action } from './media_.dish-photos_.upload.ts'

// Storage is the boundary: an upload registers a library row, as in /media.
vi.mock('#app/utils/storage.server.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof storageModule>()
	return {
		...actual,
		uploadOrganizationMediaImage: vi.fn(
			async (organizationId: string, file: File, userId: string) => {
				const objectKey = `orgs/${organizationId}/media/images/up-${crypto.randomUUID()}.png`
				await db.insert(OrganizationMediaAsset).values({
					organizationId,
					objectKey,
					mimeType: 'image/png',
					fileName: file.name,
					source: 'library',
					createdById: userId,
				})
				return objectKey
			},
		),
	}
})

function upload(slug: string, cookie: string, file: File) {
	const body = new FormData()
	body.set('intent', 'upload')
	body.set('imageFile', file)
	return action({
		request: createAuthenticatedRequest(
			`http://localhost:3000/${slug}/media/dish-photos/upload`,
			{ method: 'POST', body },
			cookie,
		),
		params: { orgSlug: slug },
		context: {},
	} as never).then(
		(res) => res as Response,
		(thrown: unknown) => thrown as Response,
	)
}

const png = () =>
	new File([new Uint8Array([1, 2, 3])], 'Beef Burger.png', {
		type: 'image/png',
	})

describe('bulk upload route (#316)', () => {
	it('runs the library upload and answers JSON with the new asset', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const res = await upload(organization.slug, cookie, png())
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			asset: { id: string; fileName: string }
		}
		expect(body.asset.fileName).toBe('Beef Burger.png')
	})

	it('keeps the library rules: not an image is refused', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const res = await upload(
			organization.slug,
			cookie,
			new File(['hello'], 'notes.txt', { type: 'text/plain' }),
		)
		expect(res.status).toBe(400)
	})

	it('keeps the library permission and membership checks', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const viewer = await createTestUser()
		await addOrganizationMember(viewer.id, organization.id, 'org_role_viewer')
		const viewerCookie = (await createTestSession(viewer.id)).cookie
		expect((await upload(organization.slug, viewerCookie, png())).status).toBe(
			403,
		)
		const outsider = await setupTestOrgWithUser('admin')
		expect(
			(await upload(organization.slug, outsider.cookie, png())).status,
		).toBe(404)
	})
})
