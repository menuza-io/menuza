import { GUEST_PHOTO_CONSENT_TEXT } from '@repo/common/guest-photos'
import { ApiError } from '@/lib/api/api-error'
import { GuestPhotosClient } from '@/lib/api/guest-photos'
import { makeSignedInSession } from '@/test/loyalty/session'
import { StubTransport } from '@/test/stub-transport'

const ELIGIBILITY = {
	eligible: true,
	orderId: 'ord_1',
	orderCreatedAt: '2026-11-20T00:00:00.000Z',
	windowDays: 14,
	maxPerDishOrder: 3,
	maxPerGuestDay: 10,
	dailyUsed: 0,
	dailyRemaining: 10,
	dishes: [
		{
			itemId: 'dish_1',
			itemName: 'Street Tacos',
			submittedCount: 0,
			remainingForDish: 3,
			eligible: true,
		},
	],
}

describe('GuestPhotosClient (#148)', () => {
	it('reads eligibility and returns null on 403 not_eligible', async () => {
		const transport = new StubTransport([
			{ json: ELIGIBILITY },
			{ status: 403, json: { error: 'not_eligible' } },
		])
		const client = new GuestPhotosClient(
			await makeSignedInSession(transport.send),
		)

		expect(await client.eligibility('ord_1')).toEqual(ELIGIBILITY)
		expect(transport.recorded[0]!.url.pathname).toBe('/photos/eligibility')
		expect(transport.recorded[0]!.url.searchParams.get('orderId')).toBe('ord_1')

		expect(await client.eligibility('ord_other')).toBeNull()
	})

	it('uploads photo and submits with consent text', async () => {
		const submission = {
			id: 'sub_1',
			orgId: 'org_1',
			orderId: 'ord_1',
			itemId: 'dish_1',
			objectKey: 'guest-photos/org_1/abc.jpg',
			contentType: 'image/jpeg',
			byteSize: 512,
			status: 'pending',
			consentText: GUEST_PHOTO_CONSENT_TEXT,
			consentedAt: '2026-11-20T01:00:00.000Z',
			decidedAt: null,
			decidedByUserId: null,
			addedAt: null,
			createdAt: '2026-11-20T01:00:00.000Z',
		}
		const transport = new StubTransport([{ status: 201, json: { submission } }])
		const uploadTransport = jest.fn(async () => ({
			status: 201,
			body: JSON.stringify({
				objectKey: 'guest-photos/org_1/abc.jpg',
				contentType: 'image/jpeg',
				byteSize: 512,
			}),
		}))

		const client = new GuestPhotosClient(
			await makeSignedInSession(transport.send),
			uploadTransport,
		)

		const uploaded = await client.upload({
			orderId: 'ord_1',
			itemId: 'dish_1',
			file: {
				uri: 'file:///tmp/taco.jpg',
				name: 'taco.jpg',
				type: 'image/jpeg',
			},
		})
		expect(uploaded).toEqual({
			objectKey: 'guest-photos/org_1/abc.jpg',
			contentType: 'image/jpeg',
			byteSize: 512,
		})
		expect(uploadTransport).toHaveBeenCalledTimes(1)

		const submitted = await client.submit({
			orderId: 'ord_1',
			itemId: 'dish_1',
			objectKey: uploaded.objectKey,
			contentType: uploaded.contentType,
			byteSize: uploaded.byteSize,
		})
		expect(submitted.status).toBe('pending')
		expect(transport.recorded[0]!.url.pathname).toBe('/photos')
		expect(transport.recorded[0]!.body).toMatchObject({
			orderId: 'ord_1',
			itemId: 'dish_1',
			consent: true,
			consentText: GUEST_PHOTO_CONSENT_TEXT,
		})
	})

	it('surfaces 500 errors from eligibility', async () => {
		const transport = new StubTransport([
			{ status: 500, json: { error: 'boom' } },
		])
		const client = new GuestPhotosClient(
			await makeSignedInSession(transport.send),
		)
		await expect(client.eligibility('ord_1')).rejects.toBeInstanceOf(ApiError)
	})
})
