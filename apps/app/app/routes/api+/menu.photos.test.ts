/**
 * #222: menu photos for the operator phone app. The route is real (bearer
 * token, permission, database); storage is the one external boundary and is
 * replaced by a recorder, so the test can read the bytes that would be stored.
 */
import {
	and,
	db,
	eq,
	OrganizationMediaAsset,
	OrganizationMenuItem,
} from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTokenPair } from '#app/utils/jwt.server.ts'
import {
	createTestUser,
	setupTestOrgWithUser,
	addOrganizationMember,
} from '#tests/test-utils.ts'

const storage = vi.hoisted(() => ({
	stored: [] as Array<{
		key: string
		bytes: Uint8Array
		name: string
		source: string
	}>,
}))

vi.mock('#app/utils/storage.server.ts', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	const { db, OrganizationMediaAsset } = await import('@repo/database')
	return {
		...actual,
		uploadOrganizationMediaImage: vi.fn(
			async (
				organizationId: string,
				file: File,
				createdById: string | undefined,
				source: string,
			) => {
				const key = `orgs/${organizationId}/media/images/${crypto.randomUUID()}.jpg`
				storage.stored.push({
					key,
					bytes: new Uint8Array(await file.arrayBuffer()),
					name: file.name,
					source,
				})
				await db.insert(OrganizationMediaAsset).values({
					organizationId,
					objectKey: key,
					mimeType: file.type,
					fileName: file.name,
					fileSize: file.size,
					width: 1200,
					height: 1200,
					source,
					createdById: createdById ?? null,
				})
				return key
			},
		),
	}
})

import { action, loader } from './menu.photos.ts'

function jpegWithGps(): Uint8Array {
	const exifBody = new TextEncoder().encode(
		'Exif\x00\x00II*\x00GPSLatitude_37.7749_GPSLongitude_-122.4194',
	)
	const app1 = new Uint8Array(4 + exifBody.length)
	app1.set(
		[
			0xff,
			0xe1,
			((exifBody.length + 2) >> 8) & 0xff,
			(exifBody.length + 2) & 0xff,
		],
		0,
	)
	app1.set(exifBody, 4)
	const sof0 = new Uint8Array([
		0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x0c, 0x00, 0x10, 0x01, 0x01, 0x11,
		0x00,
	])
	const sos = new Uint8Array([
		0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xaa, 0xbb,
	])
	const out = new Uint8Array(2 + app1.length + sof0.length + sos.length + 2)
	let o = 0
	out.set([0xff, 0xd8], o)
	o += 2
	out.set(app1, o)
	o += app1.length
	out.set(sof0, o)
	o += sof0.length
	out.set(sos, o)
	o += sos.length
	out.set([0xff, 0xd9], o)
	return out
}

async function bearer(user: { id: string; email: string; username: string }) {
	const tokens = await createTokenPair(
		{ id: user.id, email: user.email, username: user.username },
		{ userAgent: 'test', ip: '127.0.0.1' },
	)
	return `Bearer ${tokens.accessToken}`
}

async function dish(
	organizationId: string,
	name: string,
	extra: Record<string, unknown> = {},
) {
	const [row] = await db
		.insert(OrganizationMenuItem)
		.values({
			organizationId,
			displayName: JSON.stringify({ en: name }),
			price: 10,
			imageKeys: '[]',
			...extra,
		})
		.returning()
	return row!
}

function listRequest(query: Record<string, string>, auth?: string) {
	return new Request(
		`http://localhost:3000/api/menu/photos?${new URLSearchParams(query)}`,
		{ headers: auth ? { Authorization: auth } : {} },
	)
}

function uploadRequest(
	fields: Record<string, string>,
	file: { bytes: Uint8Array; type: string; name?: string } | null,
	auth?: string,
) {
	const form = new FormData()
	for (const [key, value] of Object.entries(fields)) form.set(key, value)
	if (file) {
		form.set(
			'photo',
			new File([file.bytes as BlobPart], file.name ?? 'photo.jpg', {
				type: file.type,
			}),
		)
	}
	return new Request('http://localhost:3000/api/menu/photos', {
		method: 'POST',
		headers: auth ? { Authorization: auth } : {},
		body: form,
	})
}

const run = async (fn: typeof loader | typeof action, request: Request) => {
	const result = (await fn({ request, params: {}, context: {} } as never)) as {
		data?: unknown
		init?: { status?: number }
		type?: string
	}
	const status = result?.init?.status ?? 200
	return { status, body: result.data as Record<string, any> }
}

let clientCounter = 0
const clientId = () => `client-${String(++clientCounter).padStart(8, '0')}`

beforeEach(() => {
	storage.stored.length = 0
})

describe('GET /api/menu/photos', () => {
	it('lists the dishes without a photo for the organization, best sellers first, with a count', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		const plain = await dish(organization.id, 'Plain')
		const popular = await dish(organization.id, 'Popular', { isPopular: true })
		await dish(organization.id, 'Has photo', {
			imageKey: 'orgs/x/a.jpg',
			imageKeys: JSON.stringify(['orgs/x/a.jpg']),
		})
		await dish(organization.id, 'Hidden', { availabilityStatus: 'hidden' })

		const { status, body } = await run(
			loader,
			listRequest({ organizationId: organization.id }, await bearer(user)),
		)
		expect(status).toBe(200)
		expect(body.success).toBe(true)
		expect(body.data.missingCount).toBe(2)
		expect(body.data.items.map((i: { id: string }) => i.id)).toEqual([
			popular.id,
			plain.id,
		])
		expect(body.data.items[0]).toMatchObject({
			name: 'Popular',
			hasPhoto: false,
			imageUrl: null,
		})
	})

	it("does not list another organization's dishes", async () => {
		const mine = await setupTestOrgWithUser('admin')
		const theirs = await setupTestOrgWithUser('admin')
		await dish(theirs.organization.id, 'Secret dish')
		const { body } = await run(
			loader,
			listRequest(
				{ organizationId: mine.organization.id },
				await bearer(mine.user),
			),
		)
		expect(body.data.items).toEqual([])
		// And asking for their organization is refused.
		const refused = await run(
			loader,
			listRequest(
				{ organizationId: theirs.organization.id },
				await bearer(mine.user),
			),
		)
		expect(refused.status).toBe(403)
	})

	it('finds any dish by name, with its photo, to replace it', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		await dish(organization.id, 'Margherita pizza')
		await dish(organization.id, 'Caesar salad')
		const { body } = await run(
			loader,
			listRequest(
				{ organizationId: organization.id, query: 'pizza' },
				await bearer(user),
			),
		)
		expect(body.data.items.map((i: { name: string }) => i.name)).toEqual([
			'Margherita pizza',
		])
	})

	it('refuses a signed-out request, a viewer, and a bad request', async () => {
		const { user, organization } = await setupTestOrgWithUser('viewer')
		expect(
			(await run(loader, listRequest({ organizationId: organization.id })))
				.status,
		).toBe(401)
		const viewer = await run(
			loader,
			listRequest({ organizationId: organization.id }, await bearer(user)),
		)
		expect(viewer.status).toBe(403)
		expect(viewer.body.error).toBe('forbidden')
		expect(
			(await run(loader, listRequest({}, await bearer(user)))).status,
		).toBe(400)
	})
})

describe('POST /api/menu/photos', () => {
	it('attaches the photo: the dish gets it as its main photo, the old one stays as a version, and location data is not in the stored image', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		const [oldAsset] = await db
			.insert(OrganizationMediaAsset)
			.values({
				organizationId: organization.id,
				objectKey: `orgs/${organization.id}/media/images/old-one.jpg`,
				mimeType: 'image/jpeg',
				source: 'library',
			})
			.returning()
		const item = await dish(organization.id, 'Soup', {
			imageKey: oldAsset!.objectKey,
			imageKeys: JSON.stringify([oldAsset!.objectKey]),
		})

		const { status, body } = await run(
			action,
			uploadRequest(
				{
					organizationId: organization.id,
					itemId: item.id,
					clientId: clientId(),
				},
				{ bytes: jpegWithGps(), type: 'image/jpeg' },
				await bearer(user),
			),
		)
		expect(status).toBe(200)
		expect(body.data).toMatchObject({ itemId: item.id })
		expect(body.data.imageUrl).toContain('/resources/images?mediaId=')

		// The public menu photo follows the dish row.
		const [updated] = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.id, item.id))
		const keys = JSON.parse(updated!.imageKeys) as string[]
		expect(keys[0]).toBe(storage.stored[0]!.key)
		expect(updated!.imageKey).toBe(storage.stored[0]!.key)

		// Location data and other metadata are not in the stored image.
		const text = new TextDecoder('latin1').decode(storage.stored[0]!.bytes)
		expect(text).not.toContain('GPS')
		expect(text).not.toContain('Exif')
		expect(storage.stored[0]!.source).toBe('phone')

		// Replacing keeps the old photo in the library as the original (#147).
		const [created] = await db
			.select()
			.from(OrganizationMediaAsset)
			.where(
				and(
					eq(OrganizationMediaAsset.organizationId, organization.id),
					eq(OrganizationMediaAsset.objectKey, storage.stored[0]!.key),
				),
			)
		expect(created!.parentAssetId).toBe(oldAsset!.id)
		const [stillThere] = await db
			.select()
			.from(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.id, oldAsset!.id))
		expect(stillThere).toBeDefined()
	})

	it('a member without menu edit permission cannot attach a photo', async () => {
		const owner = await setupTestOrgWithUser('admin')
		const viewer = await createTestUser()
		await addOrganizationMember(
			viewer.id,
			owner.organization.id,
			'org_role_viewer',
		)
		const item = await dish(owner.organization.id, 'Soup')
		const { status, body } = await run(
			action,
			uploadRequest(
				{
					organizationId: owner.organization.id,
					itemId: item.id,
					clientId: clientId(),
				},
				{ bytes: jpegWithGps(), type: 'image/jpeg' },
				await bearer(viewer),
			),
		)
		expect(status).toBe(403)
		expect(body.error).toBe('forbidden')
		expect(storage.stored).toHaveLength(0)
		const [row] = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.id, item.id))
		expect(row!.imageKeys).toBe('[]')
	})

	it("refuses another organization's dish", async () => {
		const mine = await setupTestOrgWithUser('admin')
		const theirs = await setupTestOrgWithUser('admin')
		const theirDish = await dish(theirs.organization.id, 'Their soup')
		const { status } = await run(
			action,
			uploadRequest(
				{
					organizationId: mine.organization.id,
					itemId: theirDish.id,
					clientId: clientId(),
				},
				{ bytes: jpegWithGps(), type: 'image/jpeg' },
				await bearer(mine.user),
			),
		)
		expect(status).toBe(404)
		const [row] = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.id, theirDish.id))
		expect(row!.imageKeys).toBe('[]')
		expect(storage.stored).toHaveLength(0)
	})

	it('refuses a wrong content type, bytes that are not an image, and an oversized file', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		const item = await dish(organization.id, 'Soup')
		const base = { organizationId: organization.id, itemId: item.id }
		const auth = await bearer(user)

		const svg = await run(
			action,
			uploadRequest(
				{ ...base, clientId: clientId() },
				{
					bytes: new TextEncoder().encode('<svg onload=alert(1)/>'),
					type: 'image/svg+xml',
				},
				auth,
			),
		)
		expect(svg.status).toBe(415)
		expect(svg.body.error).toBe('unsupported_media_type')

		const lying = await run(
			action,
			uploadRequest(
				{ ...base, clientId: clientId() },
				{
					bytes: new TextEncoder().encode('<html>not a jpeg</html>'),
					type: 'image/jpeg',
				},
				auth,
			),
		)
		expect(lying.status).toBe(415)

		const huge = await run(
			action,
			uploadRequest(
				{ ...base, clientId: clientId() },
				{ bytes: new Uint8Array(10 * 1024 * 1024 + 1), type: 'image/jpeg' },
				auth,
			),
		)
		expect(huge.status).toBe(413)
		expect(huge.body.error).toBe('payload_too_large')

		const none = await run(
			action,
			uploadRequest({ ...base, clientId: clientId() }, null, auth),
		)
		expect(none.status).toBe(400)
		expect(storage.stored).toHaveLength(0)
	})

	it('never buffers a body past the cap, even without a Content-Length', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		const item = await dish(organization.id, 'Soup')
		let sent = 0
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				// 12 MB in 1 MB chunks, no length announced.
				if (sent >= 12) return controller.close()
				sent += 1
				controller.enqueue(new Uint8Array(1024 * 1024))
			},
		})
		const request = new Request('http://localhost:3000/api/menu/photos', {
			method: 'POST',
			headers: {
				Authorization: await bearer(user),
				'Content-Type': 'multipart/form-data; boundary=x',
			},
			body: stream,
			duplex: 'half',
		} as RequestInit)
		expect(request.headers.get('content-length')).toBeNull()
		const { status, body } = await run(action, request)
		expect(status).toBe(413)
		expect(body.error).toBe('payload_too_large')
		expect(storage.stored).toHaveLength(0)
		void item
	})

	it('is idempotent per clientId: a retry stores nothing twice', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		const item = await dish(organization.id, 'Soup')
		const id = clientId()
		const auth = await bearer(user)
		const first = await run(
			action,
			uploadRequest(
				{ organizationId: organization.id, itemId: item.id, clientId: id },
				{ bytes: jpegWithGps(), type: 'image/jpeg' },
				auth,
			),
		)
		const second = await run(
			action,
			uploadRequest(
				{ organizationId: organization.id, itemId: item.id, clientId: id },
				{ bytes: jpegWithGps(), type: 'image/jpeg' },
				auth,
			),
		)
		expect(first.status).toBe(200)
		expect(second.status).toBe(200)
		expect(second.body.data.assetId).toBe(first.body.data.assetId)
		expect(storage.stored).toHaveLength(1)
	})

	it('a signed-out request is refused before anything is read', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const { status } = await run(
			action,
			uploadRequest(
				{
					organizationId: organization.id,
					itemId: 'x'.repeat(10),
					clientId: clientId(),
				},
				{ bytes: jpegWithGps(), type: 'image/jpeg' },
			),
		)
		expect(status).toBe(401)
	})
})
