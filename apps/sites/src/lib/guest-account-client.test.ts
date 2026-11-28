import { beforeEach, describe, expect, it, vi } from 'vitest'

const tenantFetch = vi.fn()
const getAccessToken = vi.fn()

vi.mock('~/lib/client-auth', () => ({
	tenantFetch: (...args: unknown[]) => tenantFetch(...args),
	getAccessToken: () => getAccessToken(),
}))

import {
	addFavorite,
	createSavedAddress,
	deleteSavedAddress,
	isSignedIn,
	listFavorites,
	listSavedAddresses,
	removeFavorite,
	updateSavedAddress,
} from './guest-account-client'

const reply = (status: number, body: unknown, session = 'ok') => ({
	session,
	response: new Response(JSON.stringify(body), { status }),
})

beforeEach(() => {
	tenantFetch.mockReset()
	getAccessToken.mockReset()
})

describe('guest account client (#113, #158)', () => {
	it('knows whether a session exists', () => {
		getAccessToken.mockReturnValue(null)
		expect(isSignedIn()).toBe(false)
		getAccessToken.mockReturnValue('token')
		expect(isSignedIn()).toBe(true)
	})

	it('lists addresses and favorites from the region', async () => {
		tenantFetch.mockResolvedValueOnce(reply(200, { addresses: [], limit: 10 }))
		expect(await listSavedAddresses()).toEqual({
			ok: true,
			data: { addresses: [], limit: 10 },
		})
		expect(tenantFetch).toHaveBeenCalledWith('/customer/addresses', {})
		tenantFetch.mockResolvedValueOnce(reply(200, { favorites: [], limit: 100 }))
		expect((await listFavorites()).ok).toBe(true)
		expect(tenantFetch).toHaveBeenLastCalledWith('/customer/favorites', {})
	})

	it('sends the right method and path for each change', async () => {
		tenantFetch.mockResolvedValue(reply(200, { ok: true }))
		await createSavedAddress({
			locationId: 'l',
			quoteToken: 'q'.repeat(20),
			label: 'Home',
		})
		expect(tenantFetch).toHaveBeenLastCalledWith(
			'/customer/addresses',
			expect.objectContaining({ method: 'POST' }),
		)
		await updateSavedAddress('a/b', { isDefault: true })
		expect(tenantFetch).toHaveBeenLastCalledWith(
			'/customer/addresses/a%2Fb',
			expect.objectContaining({ method: 'PATCH', body: '{"isDefault":true}' }),
		)
		await deleteSavedAddress('a1')
		expect(tenantFetch).toHaveBeenLastCalledWith('/customer/addresses/a1', {
			method: 'DELETE',
		})
		await addFavorite('item 1')
		expect(tenantFetch).toHaveBeenLastCalledWith(
			'/customer/favorites/item%201',
			{
				method: 'PUT',
			},
		)
		await removeFavorite('item_1')
		expect(tenantFetch).toHaveBeenLastCalledWith('/customer/favorites/item_1', {
			method: 'DELETE',
		})
	})

	it('hands the region error code back', async () => {
		tenantFetch.mockResolvedValueOnce(
			reply(409, { error: 'favorites_limit_reached' }),
		)
		expect(await addFavorite('x')).toEqual({
			ok: false,
			status: 409,
			code: 'favorites_limit_reached',
			session: 'ok',
		})
	})

	it('names an ended session and a lost connection', async () => {
		tenantFetch.mockResolvedValueOnce(reply(401, {}, 'signed_out'))
		expect(await listFavorites()).toMatchObject({
			ok: false,
			code: 'signed_out',
		})
		tenantFetch.mockResolvedValueOnce(reply(503, {}, 'transient'))
		expect(await listFavorites()).toMatchObject({
			ok: false,
			code: 'session_unavailable',
		})
		tenantFetch.mockRejectedValueOnce(new Error('offline'))
		expect(await listFavorites()).toEqual({
			ok: false,
			status: 0,
			code: 'network',
			session: 'ok',
		})
	})
})
