import { type FavoriteList } from '@repo/common/guest-favorites'
import {
	type CreateSavedAddressRequest,
	type SavedAddress,
	type SavedAddressList,
	type UpdateSavedAddressRequest,
} from '@repo/common/saved-addresses'
import {
	getAccessToken,
	tenantFetch,
	type TenantSession,
} from '~/lib/client-auth'

/**
 * The signed-in guest's saved addresses (#113) and favorite dishes (#158):
 * browser direct to the regional tenant-api with the customer token. Sites SSR
 * never sees either (docs/tenant-data-residency.md).
 */

export type AccountResult<T> =
	| { ok: true; data: T }
	| {
			ok: false
			/** 0 when the region could not be reached at all. */
			status: number
			/** The region's error code, or `network`, `signed_out`, `session_unavailable`. */
			code: string
			session: TenantSession
	  }

async function call<T>(
	path: string,
	init: RequestInit = {},
): Promise<AccountResult<T>> {
	let result: Awaited<ReturnType<typeof tenantFetch>>
	try {
		result = await tenantFetch(path, init)
	} catch {
		return { ok: false, status: 0, code: 'network', session: 'ok' }
	}
	if (result.session !== 'ok') {
		return {
			ok: false,
			status: result.response.status,
			code:
				result.session === 'signed_out' ? 'signed_out' : 'session_unavailable',
			session: result.session,
		}
	}
	const body: unknown = await result.response.json().catch(() => null)
	if (!result.response.ok) {
		const code =
			body &&
			typeof body === 'object' &&
			typeof (body as { error?: unknown }).error === 'string'
				? (body as { error: string }).error
				: 'request_failed'
		return { ok: false, status: result.response.status, code, session: 'ok' }
	}
	return { ok: true, data: body as T }
}

const json = (method: string, body: unknown): RequestInit => ({
	method,
	body: JSON.stringify(body),
})

/** Whether a guest session exists in this browser (the region still decides). */
export function isSignedIn(): boolean {
	return getAccessToken() !== null
}

export const listSavedAddresses = () =>
	call<SavedAddressList>('/customer/addresses')

export const createSavedAddress = (body: CreateSavedAddressRequest) =>
	call<{ address: SavedAddress }>('/customer/addresses', json('POST', body))

export const updateSavedAddress = (
	id: string,
	body: UpdateSavedAddressRequest,
) =>
	call<{ address: SavedAddress }>(
		`/customer/addresses/${encodeURIComponent(id)}`,
		json('PATCH', body),
	)

export const deleteSavedAddress = (id: string) =>
	call<{ ok: true }>(`/customer/addresses/${encodeURIComponent(id)}`, {
		method: 'DELETE',
	})

export const listFavorites = () => call<FavoriteList>('/customer/favorites')

export const addFavorite = (itemId: string) =>
	call<{ ok: true }>(`/customer/favorites/${encodeURIComponent(itemId)}`, {
		method: 'PUT',
	})

export const removeFavorite = (itemId: string) =>
	call<{ ok: true }>(`/customer/favorites/${encodeURIComponent(itemId)}`, {
		method: 'DELETE',
	})
