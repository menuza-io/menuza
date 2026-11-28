import { ApiError } from '@/lib/api/api-error'
import { CustomerAccountClient } from '@/lib/api/customer-account'
import { makeSignedInSession } from '@/test/loyalty/session'
import { StubTransport } from '@/test/stub-transport'

async function setup(transport: StubTransport) {
	return new CustomerAccountClient(await makeSignedInSession(transport.send))
}

const ADDRESS = {
	id: 'addr_1',
	label: 'Home',
	formatted: '233 S Wacker Dr, Chicago',
	line1: '233 S Wacker Dr',
	unit: null,
	city: 'Chicago',
	state: 'IL',
	postalCode: '60606',
	country: 'US',
	notes: null,
	isDefault: true,
	createdAt: 1,
}

describe('CustomerAccountClient, addresses (#113)', () => {
	it('lists the guest’s saved addresses with the customer token', async () => {
		const transport = new StubTransport([
			{ json: { addresses: [ADDRESS], limit: 10 } },
		])
		const list = await (await setup(transport)).listAddresses()
		expect(list.addresses[0]!.label).toBe('Home')
		const sent = transport.recorded[0]!
		expect(sent.request.method).toBe('GET')
		expect(sent.url.pathname).toBe('/customer/addresses')
		expect(sent.request.headers.Authorization).toMatch(/^Bearer /)
	})

	it('saves with the signed quote token and renames, defaults and deletes by id', async () => {
		const transport = new StubTransport([
			{ status: 201, json: { address: ADDRESS } },
			{ json: { address: { ...ADDRESS, label: 'Work' } } },
			{ json: { ok: true } },
		])
		const client = await setup(transport)
		await client.createAddress({
			locationId: 'loc_1',
			quoteToken: 'dq1.signed.token',
			label: 'Home',
		})
		expect(transport.recorded[0]!.request.method).toBe('POST')
		expect(transport.recorded[0]!.body).toEqual({
			locationId: 'loc_1',
			quoteToken: 'dq1.signed.token',
			label: 'Home',
		})
		const renamed = await client.updateAddress('addr/1', { label: 'Work' })
		expect(renamed.label).toBe('Work')
		expect(transport.recorded[1]!.request.method).toBe('PATCH')
		expect(transport.recorded[1]!.url.pathname).toBe(
			'/customer/addresses/addr%2F1',
		)
		await client.deleteAddress('addr_1')
		expect(transport.recorded[2]!.request.method).toBe('DELETE')
	})

	it('hands the region’s refusal code on', async () => {
		const transport = new StubTransport([
			{ status: 409, json: { error: 'address_limit_reached' } },
		])
		const error = await (
			await setup(transport)
		)
			.createAddress({ locationId: 'l', quoteToken: 'dq1.x.y', label: 'Home' })
			.catch((reason: unknown) => reason)
		expect(error).toBeInstanceOf(ApiError)
		expect(error).toMatchObject({ status: 409, code: 'address_limit_reached' })
	})

	it('checks a typed address against every store and keeps the first quote that delivers', async () => {
		const transport = new StubTransport([
			{
				json: {
					status: 'ok',
					locations: [
						{ locationId: 'loc_1', quote: null },
						{
							locationId: 'loc_2',
							quote: { token: 'dq1.two.sig', deliveryFee: 3 },
						},
					],
				},
			},
			{
				json: {
					status: 'ok',
					locations: [{ locationId: 'loc_1', quote: null }],
				},
			},
			{ json: { status: 'not_found' } },
			{ json: { status: 'unavailable', reason: 'no_zones' } },
		])
		const client = await setup(transport)
		expect(
			await client.checkAddress({
				address: '233 S Wacker',
				unit: '4',
				locale: 'en',
			}),
		).toEqual({
			status: 'deliverable',
			locationId: 'loc_2',
			quoteToken: 'dq1.two.sig',
		})
		expect(transport.recorded[0]!.url.pathname).toBe('/delivery/locations')
		expect(transport.recorded[0]!.body).toMatchObject({
			purpose: 'delivery',
			address: '233 S Wacker',
			unit: '4',
		})
		expect(
			(await client.checkAddress({ address: 'far away', locale: 'en' })).status,
		).toBe('not_deliverable')
		expect(
			(await client.checkAddress({ address: 'nowhere', locale: 'en' })).status,
		).toBe('not_found')
		expect(
			(await client.checkAddress({ address: 'x y z', locale: 'en' })).status,
		).toBe('unavailable')
	})
})

describe('CustomerAccountClient, favorites (#158)', () => {
	it('lists, adds and removes by dish id', async () => {
		const transport = new StubTransport([
			{ json: { favorites: [{ itemId: 'item_1', createdAt: 5 }], limit: 100 } },
			{ status: 201, json: { ok: true, itemId: 'item_2' } },
			{ json: { ok: true, itemId: 'item_2' } },
		])
		const client = await setup(transport)
		expect((await client.listFavorites()).favorites).toEqual([
			{ itemId: 'item_1', createdAt: 5 },
		])
		await client.addFavorite('item_2')
		expect(transport.recorded[1]!.request.method).toBe('PUT')
		expect(transport.recorded[1]!.url.pathname).toBe(
			'/customer/favorites/item_2',
		)
		await client.removeFavorite('item_2')
		expect(transport.recorded[2]!.request.method).toBe('DELETE')
	})

	it('surfaces the 100 favorite limit', async () => {
		const transport = new StubTransport([
			{ status: 409, json: { error: 'favorites_limit_reached' } },
		])
		await expect(
			(await setup(transport)).addFavorite('x'),
		).rejects.toMatchObject({
			code: 'favorites_limit_reached',
		})
	})
})
