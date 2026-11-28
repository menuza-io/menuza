import {
	favoriteListSchema,
	type FavoriteList,
} from '@repo/common/guest-favorites'
import {
	savedAddressListSchema,
	savedAddressSchema,
	type CreateSavedAddressRequest,
	type SavedAddress,
	type SavedAddressList,
	type UpdateSavedAddressRequest,
} from '@repo/common/saved-addresses'
import { z } from 'zod'
import { type CustomerSession } from '../session/customer-session'
import { buildUrl, decodeResponse, performRequest } from './request'

const addressEnvelope = z.object({ address: savedAddressSchema })
const okSchema = z.object({ ok: z.literal(true) }).passthrough()

const storeQuoteSchema = z.object({
	locationId: z.string(),
	quote: z.object({ token: z.string() }).passthrough().nullable(),
})
const locationsSchema = z.discriminatedUnion('status', [
	z.object({ status: z.literal('ok'), locations: z.array(storeQuoteSchema) }),
	z.object({ status: z.literal('not_found') }),
	z.object({ status: z.literal('unavailable'), reason: z.string() }),
])

/** What checking a typed address found: a store that delivers there, or why not. */
export type AddressCheck =
	| { status: 'deliverable'; locationId: string; quoteToken: string }
	| { status: 'not_deliverable' }
	| { status: 'not_found' }
	| { status: 'unavailable' }

/**
 * The signed-in guest's saved delivery addresses (#113) and favorite dishes
 * (#158): `/customer/addresses` and `/customer/favorites` on the regional
 * tenant-api, straight from the app with the customer token. Another guest's
 * address id is a 404, like one that does not exist. The app has no browser
 * Origin: the region takes the organization from the token for the delivery
 * address checks, and an address is saved only from a successful geocode.
 */
export class CustomerAccountClient {
	readonly #session: CustomerSession

	constructor(session: CustomerSession) {
		this.#session = session
	}

	listAddresses(): Promise<SavedAddressList> {
		const path = '/customer/addresses'
		return this.#send('GET', path).then((response) =>
			decodeResponse(response, savedAddressListSchema, path),
		)
	}

	createAddress(body: CreateSavedAddressRequest): Promise<SavedAddress> {
		const path = '/customer/addresses'
		return this.#send('POST', path, body).then(
			(response) => decodeResponse(response, addressEnvelope, path).address,
		)
	}

	updateAddress(
		id: string,
		body: UpdateSavedAddressRequest,
	): Promise<SavedAddress> {
		const path = `/customer/addresses/${encodeURIComponent(id)}`
		return this.#send('PATCH', path, body).then(
			(response) => decodeResponse(response, addressEnvelope, path).address,
		)
	}

	async deleteAddress(id: string): Promise<void> {
		const path = `/customer/addresses/${encodeURIComponent(id)}`
		await this.#send('DELETE', path)
	}

	listFavorites(): Promise<FavoriteList> {
		const path = '/customer/favorites'
		return this.#send('GET', path).then((response) =>
			decodeResponse(response, favoriteListSchema, path),
		)
	}

	async addFavorite(itemId: string): Promise<void> {
		const path = `/customer/favorites/${encodeURIComponent(itemId)}`
		decodeResponse(await this.#send('PUT', path), okSchema, path)
	}

	async removeFavorite(itemId: string): Promise<void> {
		const path = `/customer/favorites/${encodeURIComponent(itemId)}`
		decodeResponse(await this.#send('DELETE', path), okSchema, path)
	}

	/** Checks a typed address against every store: the first that delivers there signs a quote. */
	async checkAddress(input: {
		address: string
		unit?: string
		locale: string
	}): Promise<AddressCheck> {
		const path = '/delivery/locations'
		const response = await this.#send('POST', path, {
			purpose: 'delivery',
			locale: input.locale,
			address: input.address,
			...(input.unit ? { unit: input.unit } : {}),
		})
		const result = decodeResponse(response, locationsSchema, path)
		if (result.status === 'not_found') return { status: 'not_found' }
		if (result.status === 'unavailable') return { status: 'unavailable' }
		const store = result.locations.find((choice) => choice.quote)
		return store?.quote
			? {
					status: 'deliverable',
					locationId: store.locationId,
					quoteToken: store.quote.token,
				}
			: { status: 'not_deliverable' }
	}

	#send(
		method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
		path: string,
		json?: unknown,
		query: Array<[string, string]> = [],
	) {
		return this.#session.authorized((token) => {
			const client = this.#session.client
			return performRequest(client.transport, {
				method,
				url: buildUrl(client.regionalBaseUrl(), path, query),
				headers: {
					Accept: 'application/json',
					Authorization: `Bearer ${token}`,
				},
				...(json !== undefined ? { json } : {}),
				timeoutMs: client.configuration.requestTimeoutMs,
			})
		})
	}
}
