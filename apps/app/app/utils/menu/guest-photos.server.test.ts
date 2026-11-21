import {
	ConfigFlag,
	db,
	eq,
	inArray,
	OrganizationMediaAsset,
	OrganizationMenuItem,
} from '@repo/database'
import { jwtVerify } from 'jose'
import { ENV } from 'varlock/env'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
	process.env.SESSION_SECRET = 'test-session-secret'
	process.env.JWT_SECRET = 'test-jwt-secret-key'
	process.env.TENANT_OPERATOR_TOKEN = 'test-operator-token-32-chars-minimum'
	const workerId =
		process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0'
	process.env.DATABASE_URL = `file:./tests/database/data.${workerId}.db`
	process.env.AWS_ENDPOINT_URL_S3 = 'http://localhost:9000'
	process.env.AWS_REGION = 'us-east-1'
	process.env.AWS_ACCESS_KEY_ID = 'test'
	process.env.AWS_SECRET_ACCESS_KEY = 'test'
	process.env.BUCKET_NAME = 'test'
})

import {
	addOrganizationMember,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import {
	action as guestPhotosAction,
	loader as guestPhotosLoader,
} from '../../routes/_app+/$orgSlug_+/menu+/guest-photos.tsx'
import {
	addGuestPhotoToDish,
	GUEST_PHOTO_TOKEN_AUDIENCE,
	GUEST_PHOTO_TOKEN_TYP,
	isGuestPhotosEnabledForOrganization,
	mintGuestPhotosToken,
	removeGuestPhotoFromDish,
} from './guest-photos.server.ts'

const createdFlagIds: string[] = []
const createdItemIds: string[] = []
const createdAssetIds: string[] = []

afterEach(async () => {
	if (createdAssetIds.length) {
		await db
			.delete(OrganizationMediaAsset)
			.where(inArray(OrganizationMediaAsset.id, createdAssetIds))
		createdAssetIds.length = 0
	}
	if (createdItemIds.length) {
		await db
			.delete(OrganizationMenuItem)
			.where(inArray(OrganizationMenuItem.id, createdItemIds))
		createdItemIds.length = 0
	}
	if (createdFlagIds.length) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, createdFlagIds))
		createdFlagIds.length = 0
	}
})

async function setGuestPhotosFlag(organizationId: string, value: boolean) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({
			key: 'menu.guest_photos',
			value,
			level: 'organization',
			organizationId,
		})
		.returning({ id: ConfigFlag.id })
	createdFlagIds.push(row!.id)
}

function makeJpegWithExifBytes(): Uint8Array {
	const exifBody = new TextEncoder().encode(
		'Exif\x00\x00II*\x00GPS_LAT_37_7749',
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

describe('guest-photos App utils and route guards (#148)', () => {
	it('enforces menu.guest_photos flag and forces KSA organizations off in one helper', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		expect(
			await isGuestPhotosEnabledForOrganization({
				id: organization.id,
				dataRegion: 'us',
			}),
		).toBe(false)

		await setGuestPhotosFlag(organization.id, true)
		expect(
			await isGuestPhotosEnabledForOrganization({
				id: organization.id,
				dataRegion: 'us',
			}),
		).toBe(true)

		// Even with flag on, KSA is forced off.
		expect(
			await isGuestPhotosEnabledForOrganization({
				id: organization.id,
				dataRegion: 'ksa',
			}),
		).toBe(false)
	})

	it('mints pho+jwt with strict typ/aud/grants and refuses KSA', async () => {
		const minted = await mintGuestPhotosToken({
			organizationId: 'clw9x0a12000008l00app123',
			userId: 'user_1',
			dataRegion: 'us',
			impersonated: false,
		})
		const verified = await jwtVerify(
			minted.jwt,
			new TextEncoder().encode(ENV.TENANT_OPERATOR_TOKEN),
			{ audience: GUEST_PHOTO_TOKEN_AUDIENCE },
		)
		expect(verified.protectedHeader.typ).toBe(GUEST_PHOTO_TOKEN_TYP)
		expect(verified.payload.orgId).toBe('clw9x0a12000008l00app123')
		expect(verified.payload.grants).toEqual(['update:guest_photo:any'])

		await expect(
			mintGuestPhotosToken({
				organizationId: 'clw9x0a12000008l00app123',
				userId: 'user_1',
				dataRegion: 'ksa',
				impersonated: false,
			}),
		).rejects.toMatchObject({ status: 403 })
	})

	it('adds cleaned approved photo without EXIF to dish imageKeys, enforces dish_photos_full & not_approved, and removes cleanly', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		const [item] = await db
			.insert(OrganizationMenuItem)
			.values({
				organizationId: organization.id,
				displayName: 'Pasta',
				price: 12,
				imageKeys: '[]',
			})
			.returning()
		createdItemIds.push(item!.id)

		const jpegWithExif = makeJpegWithExifBytes()
		const jpegCopy = new Uint8Array(jpegWithExif.byteLength)
		jpegCopy.set(jpegWithExif)
		const file = new File([jpegCopy.buffer], 'dish.jpg', { type: 'image/jpeg' })

		// 1) Refuses not_approved
		const notApprovedRes = await addGuestPhotoToDish({
			organization,
			userId: user.id,
			impersonated: false,
			submissionId: 'sub_pending',
			itemId: item!.id,
			imageFile: file,
			deps: {
				fetchTenant: async () =>
					Response.json({
						submission: {
							id: 'sub_pending',
							orgId: organization.id,
							orderId: 'ord_1',
							itemId: item!.id,
							objectKey: `guest-photos/${organization.id}/a.jpg`,
							contentType: 'image/jpeg',
							byteSize: 100,
							status: 'pending',
							consentText: 'consent',
							consentedAt: new Date().toISOString(),
							decidedAt: null,
							decidedByUserId: null,
							addedAt: null,
							createdAt: new Date().toISOString(),
						},
					}),
			},
		})
		expect(notApprovedRes).toEqual({
			ok: false,
			status: 409,
			error: 'not_approved',
		})

		// 2) Approves & adds without EXIF
		let uploadedBytes: Uint8Array | null = null
		let uploadedFileName = ''
		const addOk = await addGuestPhotoToDish({
			organization,
			userId: user.id,
			impersonated: false,
			submissionId: 'sub_ok',
			itemId: item!.id,
			imageFile: file,
			deps: {
				fetchTenant: async (path) => {
					if (path.endsWith('/added')) {
						return Response.json({ ok: true })
					}
					return Response.json({
						submission: {
							id: 'sub_ok',
							orgId: organization.id,
							orderId: 'ord_1',
							itemId: item!.id,
							objectKey: `guest-photos/${organization.id}/a.jpg`,
							contentType: 'image/jpeg',
							byteSize: 100,
							status: 'approved',
							consentText: 'consent',
							consentedAt: new Date().toISOString(),
							decidedAt: new Date().toISOString(),
							decidedByUserId: user.id,
							addedAt: null,
							createdAt: new Date().toISOString(),
						},
					})
				},
				uploadMedia: async (orgId, cleanFile) => {
					uploadedBytes = new Uint8Array(await cleanFile.arrayBuffer())
					uploadedFileName = cleanFile.name
					const key = `organizations/${orgId}/media/clean-sub-ok.jpg`
					const [asset] = await db
						.insert(OrganizationMediaAsset)
						.values({
							organizationId: orgId,
							objectKey: key,
							storageScope: 'organization',
							mimeType: cleanFile.type,
							fileName: cleanFile.name,
							fileSize: cleanFile.size,
							source: 'library',
							createdById: user.id,
						})
						.returning()
					createdAssetIds.push(asset!.id)
					return key
				},
			},
		})

		expect(addOk.ok).toBe(true)
		expect(uploadedFileName).toBe('guest-photo-sub_ok.jpg')
		expect(uploadedBytes).not.toBeNull()
		expect(new TextDecoder('latin1').decode(uploadedBytes!)).not.toContain(
			'GPS_LAT_37_7749',
		)
		expect(new TextDecoder('latin1').decode(uploadedBytes!)).not.toContain(
			'Exif',
		)

		const [updatedItem] = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.id, item!.id))
		expect(JSON.parse(updatedItem!.imageKeys)).toHaveLength(1)

		// 3) Remove from dish leaves submission approved & clears imageKeys
		const removed = await removeGuestPhotoFromDish({
			organization,
			userId: user.id,
			impersonated: false,
			submissionId: 'sub_ok',
			itemId: item!.id,
			deps: {
				fetchTenant: async () =>
					Response.json({ submission: { status: 'approved' } }),
			},
		})
		expect(removed).toEqual({ ok: true, imageKeys: [] })

		// 4) dish_photos_full when item has 5 photos
		await db
			.update(OrganizationMenuItem)
			.set({ imageKeys: JSON.stringify(['k1', 'k2', 'k3', 'k4', 'k5']) })
			.where(eq(OrganizationMenuItem.id, item!.id))
		const fullRes = await addGuestPhotoToDish({
			organization,
			userId: user.id,
			impersonated: false,
			submissionId: 'sub_full',
			itemId: item!.id,
			imageFile: file,
		})
		expect(fullRes).toEqual({
			ok: false,
			status: 409,
			error: 'dish_photos_full',
		})
	})

	it('refuses unauthenticated, non-member, and missing-permission callers on guest-photos route loader and action', async () => {
		const target = await setupTestOrgWithUser('admin')
		const outsider = await setupTestOrgWithUser('admin')
		const viewer = await setupTestOrgWithUser('viewer')
		await setGuestPhotosFlag(target.organization.id, true)

		// Unauthenticated loader -> 302 login
		await expect(
			guestPhotosLoader({
				request: new Request(
					`http://localhost:3000/${target.organization.slug}/menu/guest-photos`,
				),
				params: { orgSlug: target.organization.slug },
				context: {},
			} as never),
		).rejects.toMatchObject({ status: 302 })

		// Outsider loader -> 404
		await expect(
			guestPhotosLoader({
				request: new Request(
					`http://localhost:3000/${target.organization.slug}/menu/guest-photos`,
					{ headers: { Cookie: outsider.cookie } },
				),
				params: { orgSlug: target.organization.slug },
				context: {},
			} as never),
		).rejects.toMatchObject({ status: 404 })

		// Viewer in target org without update:guest_photo:any -> 403
		await addOrganizationMember(
			viewer.user.id,
			target.organization.id,
			'org_role_viewer',
		)
		await expect(
			guestPhotosLoader({
				request: new Request(
					`http://localhost:3000/${target.organization.slug}/menu/guest-photos`,
					{ headers: { Cookie: viewer.cookie } },
				),
				params: { orgSlug: target.organization.slug },
				context: {},
			} as never),
		).rejects.toMatchObject({ status: 403 })
		await expect(
			guestPhotosAction({
				request: new Request(
					`http://localhost:3000/${target.organization.slug}/menu/guest-photos`,
					{ method: 'POST', headers: { Cookie: viewer.cookie } },
				),
				params: { orgSlug: target.organization.slug },
				context: {},
			} as never),
		).rejects.toMatchObject({ status: 403 })

		// Unauthenticated action -> 302 login
		await expect(
			guestPhotosAction({
				request: new Request(
					`http://localhost:3000/${target.organization.slug}/menu/guest-photos`,
					{ method: 'POST' },
				),
				params: { orgSlug: target.organization.slug },
				context: {},
			} as never),
		).rejects.toMatchObject({ status: 302 })
	})
})
