import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import { GUEST_PHOTO_CONSENT_TEXT } from '@repo/common/guest-photos'
import {
	customers,
	destroyTenantDb,
	getTenantDb,
	guestPhotoSubmissions,
	provisionTenantDb,
	restaurantOrders,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	GUEST_PHOTO_OPERATOR_PERMISSION,
	GUEST_PHOTO_TOKEN_AUDIENCE,
	GUEST_PHOTO_TOKEN_TYP,
	resetGuestPhotosContextForTests,
	seedGuestPhotosContextForTest,
} from '../lib/guest-photo-auth.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import {
	type GuestPhotoStorageAdapter,
	purgeExpiredRejectedGuestPhotos,
} from '../services/guest-photos-service.ts'
import { insertOrder } from '../services/loyalty-test-fixture.ts'
import { createGuestPhotoRoutes, guestPhotoTickRoutes } from './guest-photos.ts'
import { createOperatorGuestPhotoRoutes } from './operator-guest-photos.ts'

const orgA = 'clw9x0a12000008l00phot01'
const orgB = 'clw9x0a12000008l00phot02'
const orgKsa = 'clw9x0a12000008l00phot03'
const jwtSecret = 'test-jwt-secret-123456789'
const operatorSecret = 'test-operator-secret-key-32-chars!!'
const internalSecret = 'test-internal-command-token-32-chars'

vi.mock('../lib/origin.ts', () => {
	const orgs: Record<
		string,
		{
			id: string
			slug: string
			customDomain: null
			hasProvisionedDb: true
			dataRegion: string
		}
	> = {
		clw9x0a12000008l00phot01: {
			id: 'clw9x0a12000008l00phot01',
			slug: 'photos-a',
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
		},
		clw9x0a12000008l00phot02: {
			id: 'clw9x0a12000008l00phot02',
			slug: 'photos-b',
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
		},
		clw9x0a12000008l00phot03: {
			id: 'clw9x0a12000008l00phot03',
			slug: 'photos-ksa',
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'ksa',
		},
	}
	return {
		findActiveOrganizationById: vi.fn(async (id: string) => orgs[id] ?? null),
		lookupActiveOrganization: vi.fn(async (id: string) =>
			orgs[id]
				? { status: 'found', organization: orgs[id] }
				: { status: 'missing' },
		),
		resolveOrganizationFromOrigin: vi.fn(async (origin: string | undefined) => {
			if (!origin) return null
			if (origin.includes('photos-b')) return orgs.clw9x0a12000008l00phot02
			if (origin.includes('photos-a')) return orgs.clw9x0a12000008l00phot01
			return null
		}),
	}
})

function makeJpegWithExif(): Uint8Array {
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

async function customerToken(
	customerId: string,
	targetOrgId = orgA,
	options: { aud?: string; secret?: string } = {},
) {
	return new SignJWT({
		customerId,
		orgId: targetOrgId,
		name: 'Guest',
		orgSlug: 'photos-a',
		type: 'access',
	})
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience(options.aud ?? 'tenant-api')
		.setIssuer(brand.slug)
		.setExpirationTime('15m')
		.sign(new TextEncoder().encode(options.secret ?? jwtSecret))
}

async function operatorPhotoToken(
	targetOrgId = orgA,
	options: {
		aud?: string
		typ?: string
		secret?: string
		region?: 'us' | 'ksa'
		grants?: string[]
		impersonated?: boolean
		ttlSeconds?: number
	} = {},
) {
	const now = Math.floor(Date.now() / 1000)
	const ttl = options.ttlSeconds ?? 300
	return new SignJWT({
		role: 'operator',
		region: options.region ?? 'us',
		orgId: targetOrgId,
		grants: options.grants ?? [GUEST_PHOTO_OPERATOR_PERMISSION],
		impersonated: options.impersonated ?? false,
	})
		.setProtectedHeader({
			alg: 'HS256',
			...(options.typ === ''
				? {}
				: { typ: options.typ ?? GUEST_PHOTO_TOKEN_TYP }),
		})
		.setAudience(options.aud ?? GUEST_PHOTO_TOKEN_AUDIENCE)
		.setIssuer(brand.shortName)
		.setSubject('user_op_1')
		.setIssuedAt(now)
		.setExpirationTime(now + ttl)
		.sign(new TextEncoder().encode(options.secret ?? operatorSecret))
}

describe('guest dish photos routes (#148)', () => {
	let tempDir: string
	let prevTenantDir: string | undefined
	let app: Hono
	let bucket: Map<string, { bytes: Uint8Array; contentType: string }>
	let aliceId: string
	let bobId: string
	let aliceOrderId: string
	let bobOrderId: string

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-photos-test-'))
		prevTenantDir = process.env.TENANT_DB_DIR
		process.env.TENANT_DB_DIR = tempDir
		process.env.JWT_SECRET = jwtSecret
		process.env.TENANT_OPERATOR_TOKEN = operatorSecret
		process.env.INTERNAL_COMMAND_TOKEN = internalSecret
		process.env.DATA_REGION = 'us'
		vi.stubEnv('GUEST_PHOTOS_ENABLED', '')
		syncEnvFromProcess()
		resetGuestPhotosContextForTests()
		seedGuestPhotosContextForTest(orgA, true)
		seedGuestPhotosContextForTest(orgB, true)
		seedGuestPhotosContextForTest(orgKsa, true)

		bucket = new Map()
		const storage: GuestPhotoStorageAdapter = {
			putObject: async (key, bytes, contentType) => {
				bucket.set(key, { bytes, contentType })
				return 'uploaded'
			},
			headObject: async (key) => {
				const obj = bucket.get(key)
				return obj
					? {
							status: 'found',
							sizeBytes: obj.bytes.byteLength,
							contentType: obj.contentType,
						}
					: { status: 'missing' }
			},
			deleteObject: async (key) => {
				bucket.delete(key)
				return 'deleted'
			},
			presignRead: (key) =>
				bucket.has(key)
					? {
							url: `https://r2.example.test/${key}?sig=1`,
							expiresAt: Date.now() + 120_000,
						}
					: null,
		}

		app = new Hono()
		app.route('/photos', createGuestPhotoRoutes({ storage }))
		app.route('/operator/photos', createOperatorGuestPhotoRoutes({ storage }))
		app.route('/api/guest-photos', guestPhotoTickRoutes)

		await provisionTenantDb(orgA)
		await provisionTenantDb(orgB)
		const dbA = await getTenantDb(orgA)

		const [alice] = await dbA
			.insert(customers)
			.values({ name: 'Alice', phone: '+15550001001', phoneVerified: true })
			.returning()
		const [bob] = await dbA
			.insert(customers)
			.values({ name: 'Bob', phone: '+15550001002', phoneVerified: true })
			.returning()
		aliceId = alice!.id
		bobId = bob!.id

		aliceOrderId = await insertOrder(orgA, {
			customerId: aliceId,
			status: 'completed',
			paymentMethod: 'online',
			paymentStatus: 'paid',
			createdAt: new Date(),
			lines: [
				{
					itemId: 'dish_tacos',
					itemName: 'Street Tacos',
					quantity: 1,
					unitPriceCents: 1200,
					taxableUnitCents: 1200,
					totalCents: 1200,
					taxableCents: 1200,
				},
			],
		})

		bobOrderId = await insertOrder(orgA, {
			customerId: bobId,
			status: 'completed',
			paymentMethod: 'online',
			paymentStatus: 'paid',
			createdAt: new Date(),
			lines: [
				{
					itemId: 'dish_burger',
					itemName: 'Smash Burger',
					quantity: 1,
					unitPriceCents: 1500,
					taxableUnitCents: 1500,
					totalCents: 1500,
					taxableCents: 1500,
				},
			],
		})
	})

	afterEach(async () => {
		vi.unstubAllEnvs()
		delete process.env.GUEST_PHOTOS_ENABLED
		resetGuestPhotosContextForTests()
		await destroyTenantDb(orgA)
		await destroyTenantDb(orgB)
		if (prevTenantDir === undefined) delete process.env.TENANT_DB_DIR
		else process.env.TENANT_DB_DIR = prevTenantDir
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('allows a guest who ordered a dish to upload (EXIF stripped) and submit; refuses non-ordered dish with not_eligible', async () => {
		const token = await customerToken(aliceId)

		// Eligible check
		const eligRes = await app.request(
			`/photos/eligibility?orderId=${aliceOrderId}`,
			{ headers: { Authorization: `Bearer ${token}` } },
		)
		expect(eligRes.status).toBe(200)
		const eligBody = (await eligRes.json()) as {
			eligible: boolean
			dishes: Array<{ itemId: string; remainingForDish: number }>
		}
		expect(eligBody.eligible).toBe(true)
		expect(eligBody.dishes[0]).toMatchObject({
			itemId: 'dish_tacos',
			remainingForDish: 3,
		})

		// Non-ordered dish -> not_eligible
		const notOrderedRes = await app.request(
			`/photos/eligibility?orderId=${aliceOrderId}&itemId=dish_burger`,
			{ headers: { Authorization: `Bearer ${token}` } },
		)
		expect(notOrderedRes.status).toBe(403)
		expect(await notOrderedRes.json()).toMatchObject({ error: 'not_eligible' })

		// Another guest's order -> not_eligible
		const otherOrderRes = await app.request(
			`/photos/eligibility?orderId=${bobOrderId}`,
			{ headers: { Authorization: `Bearer ${token}` } },
		)
		expect(otherOrderRes.status).toBe(403)
		expect(await otherOrderRes.json()).toMatchObject({ error: 'not_eligible' })

		// Upload photo with EXIF + GPS
		const form = new FormData()
		form.set('orderId', aliceOrderId)
		form.set('itemId', 'dish_tacos')
		form.set(
			'file',
			new File([makeJpegWithExif()], 'tacos.jpg', { type: 'image/jpeg' }),
		)

		const uploadRes = await app.request('/photos/upload', {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}` },
			body: form,
		})
		expect(uploadRes.status).toBe(201)
		const uploaded = (await uploadRes.json()) as {
			objectKey: string
			contentType: string
			byteSize: number
		}
		expect(uploaded.objectKey.startsWith(`guest-photos/${orgA}/`)).toBe(true)

		// Verify stored object in R2 has zero EXIF/GPS
		const stored = bucket.get(uploaded.objectKey)!
		const storedText = new TextDecoder('latin1').decode(stored.bytes)
		expect(storedText).not.toContain('GPS_LAT_37_7749')
		expect(storedText).not.toContain('Exif')

		// Submit with consent
		const submitRes = await app.request('/photos', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				orderId: aliceOrderId,
				itemId: 'dish_tacos',
				objectKey: uploaded.objectKey,
				contentType: uploaded.contentType,
				byteSize: uploaded.byteSize,
				consent: true,
			}),
		})
		expect(submitRes.status).toBe(201)
		const submitted = (await submitRes.json()) as {
			submission: { id: string; status: string; consentText: string }
		}
		expect(submitted.submission.status).toBe('pending')
		expect(submitted.submission.consentText).toBe(GUEST_PHOTO_CONSENT_TEXT)
		expect(submitted.submission).not.toHaveProperty('customerId')
	})

	it('refuses orders older than 14 days and cancelled orders with not_eligible', async () => {
		const dbA = await getTenantDb(orgA)
		const oldDate = new Date(Date.now() - 15 * 86_400_000)
		await dbA
			.update(restaurantOrders)
			.set({ createdAt: oldDate })
			.where(eq(restaurantOrders.id, aliceOrderId))

		const token = await customerToken(aliceId)
		const oldRes = await app.request(
			`/photos/eligibility?orderId=${aliceOrderId}`,
			{ headers: { Authorization: `Bearer ${token}` } },
		)
		expect(oldRes.status).toBe(403)
		expect(await oldRes.json()).toMatchObject({ error: 'not_eligible' })

		// Bob's order cancelled
		await dbA
			.update(restaurantOrders)
			.set({ status: 'cancelled' })
			.where(eq(restaurantOrders.id, bobOrderId))
		const bobTok = await customerToken(bobId)
		const cancelledRes = await app.request(
			`/photos/eligibility?orderId=${bobOrderId}`,
			{ headers: { Authorization: `Bearer ${bobTok}` } },
		)
		expect(cancelledRes.status).toBe(403)
		expect(await cancelledRes.json()).toMatchObject({ error: 'not_eligible' })
	})

	it('enforces 3/dish/order and 10/guest/day caps and rejects disguised non-images', async () => {
		const token = await customerToken(aliceId)
		const dbA = await getTenantDb(orgA)

		// Disguised SVG claiming JPEG
		const badForm = new FormData()
		badForm.set('orderId', aliceOrderId)
		badForm.set('itemId', 'dish_tacos')
		badForm.set(
			'file',
			new File([new TextEncoder().encode('<svg/>')], 'fake.jpg', {
				type: 'image/jpeg',
			}),
		)
		const badRes = await app.request('/photos/upload', {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}` },
			body: badForm,
		})
		expect(badRes.status).toBe(400)
		expect(await badRes.json()).toMatchObject({
			error: 'unsupported_image_type',
		})

		// Seed 3 submissions on same order+dish -> 4th rejected
		const now = new Date()
		for (let i = 0; i < 3; i++) {
			await dbA.insert(guestPhotoSubmissions).values({
				id: `cap_dish_${i}`,
				orgId: orgA,
				customerId: aliceId,
				orderId: aliceOrderId,
				itemId: 'dish_tacos',
				objectKey: `guest-photos/${orgA}/00000000-0000-0000-0000-00000000000${i}.jpg`,
				contentType: 'image/jpeg',
				byteSize: 100,
				status: 'pending',
				consentText: GUEST_PHOTO_CONSENT_TEXT,
				consentedAt: now,
				createdAt: now,
			})
		}

		const capForm = new FormData()
		capForm.set('orderId', aliceOrderId)
		capForm.set('itemId', 'dish_tacos')
		capForm.set(
			'file',
			new File([makeJpegWithExif()], '4th.jpg', { type: 'image/jpeg' }),
		)
		const capRes = await app.request('/photos/upload', {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}` },
			body: capForm,
		})
		expect(capRes.status).toBe(429)
		expect(await capRes.json()).toMatchObject({
			error: 'dish_order_limit_reached',
		})

		// Second order with 7 more submissions -> 10/day reached -> 11th rejected
		const order2Id = await insertOrder(orgA, {
			customerId: aliceId,
			status: 'completed',
			paymentMethod: 'online',
			paymentStatus: 'paid',
			createdAt: new Date(),
			lines: [
				{
					itemId: 'dish_burrito',
					itemName: 'Burrito',
					quantity: 1,
					unitPriceCents: 1000,
					taxableUnitCents: 1000,
					totalCents: 1000,
					taxableCents: 1000,
				},
			],
		})
		for (let i = 0; i < 7; i++) {
			await dbA.insert(guestPhotoSubmissions).values({
				id: `cap_day_${i}`,
				orgId: orgA,
				customerId: aliceId,
				orderId: order2Id,
				itemId: 'dish_burrito',
				objectKey: `guest-photos/${orgA}/00000000-0000-0000-0000-00000000010${i}.jpg`,
				contentType: 'image/jpeg',
				byteSize: 100,
				status: 'pending',
				consentText: GUEST_PHOTO_CONSENT_TEXT,
				consentedAt: now,
				createdAt: now,
			})
		}
		const dayForm = new FormData()
		dayForm.set('orderId', order2Id)
		dayForm.set('itemId', 'dish_burrito')
		dayForm.set(
			'file',
			new File([makeJpegWithExif()], '11th.jpg', { type: 'image/jpeg' }),
		)
		const dayRes = await app.request('/photos/upload', {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}` },
			body: dayForm,
		})
		expect(dayRes.status).toBe(429)
		expect(await dayRes.json()).toMatchObject({ error: 'daily_limit_reached' })
	})

	it('enforces security checks on customer and operator routes (forged, wrong aud/typ, cross-org, KSA, kill switch)', async () => {
		const validCust = await customerToken(aliceId)
		const forgedCust = await customerToken(aliceId, orgA, {
			secret: 'wrong-secret-1234567890',
		})
		const wrongAudCust = await customerToken(aliceId, orgA, {
			aud: 'other-audience',
		})

		expect(
			(await app.request(`/photos/eligibility?orderId=${aliceOrderId}`)).status,
		).toBe(401)
		expect(
			(
				await app.request(`/photos/eligibility?orderId=${aliceOrderId}`, {
					headers: { Authorization: `Bearer ${forgedCust}` },
				})
			).status,
		).toBe(401)
		expect(
			(
				await app.request(`/photos/eligibility?orderId=${aliceOrderId}`, {
					headers: { Authorization: `Bearer ${wrongAudCust}` },
				})
			).status,
		).toBe(401)

		// Cross-org origin refused
		const crossOriginRes = await app.request(
			`/photos/eligibility?orderId=${aliceOrderId}`,
			{
				headers: {
					Authorization: `Bearer ${validCust}`,
					Origin: 'https://photos-b.menuza.test',
				},
			},
		)
		expect(crossOriginRes.status).toBe(403)

		// Operator pho+jwt checks
		expect((await app.request('/operator/photos')).status).toBe(401)
		expect(
			(
				await app.request('/operator/photos', {
					headers: {
						Authorization: `Bearer ${await operatorPhotoToken(orgA, { secret: 'wrong-secret-key-32-chars-minimum!' })}`,
					},
				})
			).status,
		).toBe(401)
		expect(
			(
				await app.request('/operator/photos', {
					headers: {
						Authorization: `Bearer ${await operatorPhotoToken(orgA, { aud: 'tenant-api-operator' })}`,
					},
				})
			).status,
		).toBe(401)
		expect(
			(
				await app.request('/operator/photos', {
					headers: {
						Authorization: `Bearer ${await operatorPhotoToken(orgA, { typ: 'inv+jwt' })}`,
					},
				})
			).status,
		).toBe(401)
		expect(
			(
				await app.request('/operator/photos', {
					headers: {
						Authorization: `Bearer ${await operatorPhotoToken(orgA, { region: 'ksa' })}`,
					},
				})
			).status,
		).toBe(403)

		// Cross-org operator token cannot see Org A submissions
		const dbA = await getTenantDb(orgA)
		const subKey = `guest-photos/${orgA}/00000000-0000-0000-0000-000000000999.jpg`
		bucket.set(subKey, { bytes: makeJpegWithExif(), contentType: 'image/jpeg' })
		await dbA.insert(guestPhotoSubmissions).values({
			id: 'sub_org_a',
			orgId: orgA,
			customerId: aliceId,
			orderId: aliceOrderId,
			itemId: 'dish_tacos',
			objectKey: subKey,
			contentType: 'image/jpeg',
			byteSize: 100,
			status: 'pending',
			consentText: GUEST_PHOTO_CONSENT_TEXT,
			consentedAt: new Date(),
			createdAt: new Date(),
		})

		const orgBOpToken = await operatorPhotoToken(orgB)
		const crossOpList = await app.request('/operator/photos', {
			headers: { Authorization: `Bearer ${orgBOpToken}` },
		})
		expect(crossOpList.status).toBe(200)
		expect(
			((await crossOpList.json()) as { submissions: unknown[] }).submissions,
		).toEqual([])
		const crossOpGet = await app.request('/operator/photos/sub_org_a', {
			headers: { Authorization: `Bearer ${orgBOpToken}` },
		})
		expect(crossOpGet.status).toBe(404)

		// Flag off -> 403 guest_photos_disabled
		seedGuestPhotosContextForTest(orgA, false)
		const flagOffRes = await app.request(
			`/photos/eligibility?orderId=${aliceOrderId}`,
			{ headers: { Authorization: `Bearer ${validCust}` } },
		)
		expect(flagOffRes.status).toBe(403)
		expect(await flagOffRes.json()).toMatchObject({
			error: 'guest_photos_disabled',
		})

		// Kill switch -> 503 guest_photos_unavailable
		seedGuestPhotosContextForTest(orgA, true)
		vi.stubEnv('GUEST_PHOTOS_ENABLED', 'false')
		const killCustRes = await app.request(
			`/photos/eligibility?orderId=${aliceOrderId}`,
			{ headers: { Authorization: `Bearer ${validCust}` } },
		)
		expect(killCustRes.status).toBe(503)
		const killOpRes = await app.request('/operator/photos', {
			headers: { Authorization: `Bearer ${await operatorPhotoToken(orgA)}` },
		})
		expect(killOpRes.status).toBe(503)
	})

	it('enforces operator state machine (already_decided, not_approved, remove leaves approved) and purges 30-day rejected submissions', async () => {
		const dbA = await getTenantDb(orgA)
		const subKey = `guest-photos/${orgA}/00000000-0000-0000-0000-000000000888.jpg`
		bucket.set(subKey, { bytes: makeJpegWithExif(), contentType: 'image/jpeg' })
		await dbA.insert(guestPhotoSubmissions).values({
			id: 'sub_flow',
			orgId: orgA,
			customerId: aliceId,
			orderId: aliceOrderId,
			itemId: 'dish_tacos',
			objectKey: subKey,
			contentType: 'image/jpeg',
			byteSize: 100,
			status: 'pending',
			consentText: GUEST_PHOTO_CONSENT_TEXT,
			consentedAt: new Date(),
			createdAt: new Date(),
		})

		const opTok = await operatorPhotoToken(orgA)

		// Cannot add or get signed url while pending
		const signedPendingRes = await app.request(
			'/operator/photos/sub_flow/signed-url',
			{
				headers: { Authorization: `Bearer ${opTok}` },
			},
		)
		const signedPendingBody = await signedPendingRes.json()
		expect({
			status: signedPendingRes.status,
			body: signedPendingBody,
		}).toEqual({
			status: 409,
			body: expect.objectContaining({ error: 'not_approved' }),
		})
		const addPendingRes = await app.request('/operator/photos/sub_flow/added', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${opTok}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({}),
		})
		expect(addPendingRes.status).toBe(409)
		expect(await addPendingRes.json()).toMatchObject({ error: 'not_approved' })

		// Approve once
		const approveRes = await app.request('/operator/photos/sub_flow/decide', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${opTok}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ decision: 'approve' }),
		})
		expect(approveRes.status).toBe(200)

		// Second decision -> already_decided
		const secondDecide = await app.request('/operator/photos/sub_flow/decide', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${opTok}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ decision: 'reject' }),
		})
		expect(secondDecide.status).toBe(409)
		expect(await secondDecide.json()).toMatchObject({
			error: 'already_decided',
		})

		// Signed URL works when approved
		const signedRes = await app.request(
			'/operator/photos/sub_flow/signed-url',
			{
				headers: { Authorization: `Bearer ${opTok}` },
			},
		)
		expect(signedRes.status).toBe(200)
		expect(await signedRes.json()).toMatchObject({
			url: expect.stringContaining(subKey),
			itemId: 'dish_tacos',
		})

		// Mark added -> status becomes added
		const addedRes = await app.request('/operator/photos/sub_flow/added', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${opTok}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({}),
		})
		expect(addedRes.status).toBe(200)
		expect(
			((await addedRes.json()) as { submission: { status: string } }).submission
				.status,
		).toBe('added')

		// Remove from dish -> returns to approved
		const removeRes = await app.request('/operator/photos/sub_flow/remove', {
			method: 'POST',
			headers: { Authorization: `Bearer ${opTok}` },
		})
		expect(removeRes.status).toBe(200)
		expect(
			((await removeRes.json()) as { submission: { status: string } })
				.submission.status,
		).toBe('approved')

		// 30-day rejected purge
		const now = Date.now()
		const oldRejectedKey = `guest-photos/${orgA}/00000000-0000-0000-0000-000000000777.jpg`
		const freshRejectedKey = `guest-photos/${orgA}/00000000-0000-0000-0000-000000000778.jpg`
		bucket.set(oldRejectedKey, {
			bytes: new Uint8Array([1, 2]),
			contentType: 'image/jpeg',
		})
		bucket.set(freshRejectedKey, {
			bytes: new Uint8Array([1, 2]),
			contentType: 'image/jpeg',
		})
		await dbA.insert(guestPhotoSubmissions).values([
			{
				id: 'rej_old',
				orgId: orgA,
				customerId: aliceId,
				orderId: aliceOrderId,
				itemId: 'dish_tacos',
				objectKey: oldRejectedKey,
				contentType: 'image/jpeg',
				byteSize: 2,
				status: 'rejected',
				consentText: GUEST_PHOTO_CONSENT_TEXT,
				consentedAt: new Date(now - 35 * 86_400_000),
				decidedAt: new Date(now - 31 * 86_400_000),
				decidedByUserId: 'op_1',
				createdAt: new Date(now - 35 * 86_400_000),
			},
			{
				id: 'rej_fresh',
				orgId: orgA,
				customerId: aliceId,
				orderId: aliceOrderId,
				itemId: 'dish_tacos',
				objectKey: freshRejectedKey,
				contentType: 'image/jpeg',
				byteSize: 2,
				status: 'rejected',
				consentText: GUEST_PHOTO_CONSENT_TEXT,
				consentedAt: new Date(now - 5 * 86_400_000),
				decidedAt: new Date(now - 5 * 86_400_000),
				decidedByUserId: 'op_1',
				createdAt: new Date(now - 5 * 86_400_000),
			},
		])

		const deletedKeys: string[] = []
		const purge = await purgeExpiredRejectedGuestPhotos(dbA, {
			now,
			storage: {
				deleteObject: async (k) => {
					deletedKeys.push(k)
					bucket.delete(k)
					return 'deleted'
				},
			},
		})
		expect(purge).toEqual({ purged: 1, failed: 0 })
		expect(deletedKeys).toEqual([oldRejectedKey])
		expect(bucket.has(oldRejectedKey)).toBe(false)
		expect(bucket.has(freshRejectedKey)).toBe(true)

		// Tick auth check
		expect(
			(
				await app.request('/api/guest-photos/tick', {
					method: 'POST',
					headers: { Authorization: 'Bearer wrong-token' },
				})
			).status,
		).toBe(401)
		expect(
			(
				await app.request('/api/guest-photos/tick', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${internalSecret}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ orgId: orgA }),
				})
			).status,
		).toBe(200)
	})
})
