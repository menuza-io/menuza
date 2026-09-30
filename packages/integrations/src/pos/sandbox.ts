/**
 * In-process POS sandbox: MSW handlers that answer provider requests with each
 * platform's real request shapes. Installed by the dev server (and tests) so
 * connecting, importing and syncing work without platform credentials. Ported
 * from the Mise reference project (`lib/pos/mock-server.ts`).
 *
 * Stores are keyed per connection (the `x-pos-store` header the transport
 * sends) so a catalog persists across calls within a process.
 */

import { randomUUID } from 'node:crypto'
import { http, HttpResponse, passthrough } from 'msw'
import { POS_SANDBOX_TOKEN, shouldSkipMock } from './credentials.ts'
import { snapshotOf, pick } from './snapshot.ts'
import { POS_MERCHANT_HEADER, POS_STORE_HEADER } from './transport.ts'
import {
	posProviders,
	readFields,
	sandboxUrls,
	type PosProvider,
	type RemoteItem,
	type RemoteMenu,
} from './types.ts'
import {
	cloverWire,
	doordashWire,
	squareWire,
	toastWire,
	uberWire,
} from './wire.ts'

type Catalog = {
	items: RemoteItem[]
	menus: RemoteMenu[]
	currency: string
	version: number
}
type Store = { provider: PosProvider; merchantId: string; catalog: Catalog }

const stores = new Map<string, Store>()

export function resetPosSandbox() {
	stores.clear()
}

const json = (body: unknown, status = 200) =>
	HttpResponse.json(body as Record<string, unknown>, {
		status,
		headers: { 'x-pos-sandbox': 'true' },
	})
const noContent = () =>
	new HttpResponse(null, {
		status: 204,
		headers: { 'x-pos-sandbox': 'true' },
	})

function item(
	id: string,
	name: string,
	category: string,
	price: number,
	menus: string[],
	modifierGroups: RemoteItem['modifierGroups'] = [],
): RemoteItem {
	return {
		id,
		name,
		description: `${name} from the sandbox menu`,
		category,
		price,
		imageUrl: null,
		available: true,
		modifierGroups,
		variations: [],
		menus,
		allergens: [],
		alcohol: false,
		taxRate: null,
		version: 1,
	}
}

function seedCatalog(): Catalog {
	return {
		currency: 'USD',
		version: 1,
		menus: [
			{ name: 'Lunch', days: [0, 1, 2, 3, 4], start: '11:00', end: '15:00' },
		],
		items: [
			item('starter-1', 'Garlic Bread', 'Starters', 499, ['Lunch']),
			item('starter-2', 'Mozzarella Sticks', 'Starters', 699, ['Lunch']),
			item(
				'main-1',
				'Margherita Pizza',
				'Mains',
				1299,
				['Lunch'],
				[
					{
						name: 'Extra toppings',
						min: 0,
						max: 3,
						options: [
							{ name: 'Olives', price: 100 },
							{ name: 'Mushrooms', price: 120 },
						],
					},
				],
			),
			item('main-2', 'Veggie Burger', 'Mains', 1099, ['Lunch']),
		],
	}
}

function getStore(request: { headers: Headers }, provider: PosProvider): Store {
	const storeId = request.headers.get(POS_STORE_HEADER)
	const merchantId = request.headers.get(POS_MERCHANT_HEADER)
	if (!storeId || !merchantId) {
		throw new SandboxAuthError()
	}
	const existing = stores.get(storeId)
	if (existing) return existing
	const created: Store = { provider, merchantId, catalog: seedCatalog() }
	stores.set(storeId, created)
	return created
}

class SandboxAuthError extends Error {}

const unauthorized = () => json({ error: 'Unauthorized sandbox request' }, 401)

function mergeInto(
	provider: PosProvider,
	target: RemoteItem,
	incoming: RemoteItem,
) {
	Object.assign(
		target,
		pick(snapshotOf(target), snapshotOf(incoming), readFields[provider]),
		{
			version: target.version + 1,
		},
	)
}
function replaceCatalog(
	catalog: Catalog,
	incoming: RemoteItem[],
	menus: RemoteMenu[],
) {
	const previous = new Map(catalog.items.map((entry) => [entry.id, entry]))
	catalog.items = incoming.map((entry) => ({
		...entry,
		version: (previous.get(entry.id)?.version ?? 0) + 1,
	}))
	catalog.menus = menus
	catalog.version++
}

function handler(provider: PosProvider) {
	return http.all(`${sandboxUrls[provider]}/*`, async ({ request }) => {
		// Real credentials configured for this platform: let the request through
		// to the actual API instead of answering it from the sandbox.
		if (shouldSkipMock(provider)) return passthrough()
		if (
			request.headers.get('authorization') !== `Bearer ${POS_SANDBOX_TOKEN}`
		) {
			return unauthorized()
		}
		let store: Store
		try {
			store = getStore(request, provider)
		} catch {
			return unauthorized()
		}
		const { catalog } = store
		const merchantId = store.merchantId
		const url = new URL(request.url)
		const path = url.pathname
		const method = request.method
		const body = async <T>() => (await request.json()) as T
		const find = (id: string) =>
			catalog.items.find((entry) => entry.id === decodeURIComponent(id))

		if (path.endsWith('/pause') && method === 'POST') {
			return json({ pausedUntil: null })
		}

		if (provider === 'clover') {
			const root = `/v3/merchants/${merchantId}`
			if (path === root) {
				return json({
					id: merchantId,
					name: 'Sandbox Restaurant',
					currency: catalog.currency,
					phoneNumber: '+15550199',
					address: {
						address1: '123 Market St',
						city: 'San Francisco',
						state: 'CA',
						zip: '94103',
						country: 'US',
					},
				})
			}
			if (path === `${root}/items` && method === 'GET') {
				const offset = Number(url.searchParams.get('offset') ?? 0)
				const limit = Number(url.searchParams.get('limit') ?? 100)
				return json({
					elements: catalog.items
						.slice(offset, offset + limit)
						.map(cloverWire.encode),
				})
			}
			if (path === `${root}/items` && method === 'POST') {
				const decoded = cloverWire.decode({
					...(await body<Record<string, unknown>>()),
					id: `CLOVER_ITEM_${randomUUID().slice(0, 8).toUpperCase()}`,
				})
				catalog.items.push({ ...decoded, version: 1 })
				catalog.version++
				return json(cloverWire.encode(catalog.items.at(-1)!))
			}
			const match = path.match(new RegExp(`^${root}/items/([^/]+)$`))
			if (match) {
				const target = find(match[1]!)
				if (!target) return json({ message: 'Not found' }, 404)
				if (method === 'DELETE') {
					catalog.items = catalog.items.filter((entry) => entry !== target)
					catalog.version++
					return json({})
				}
				const data = await body<Record<string, unknown>>()
				if (Object.keys(data).length === 1 && 'available' in data) {
					Object.assign(target, {
						available: Boolean(data.available),
						version: target.version + 1,
					})
				} else {
					mergeInto(
						provider,
						target,
						cloverWire.decode({ ...data, id: target.id }),
					)
				}
				catalog.version++
				return json(cloverWire.encode(target))
			}
		}

		if (provider === 'square') {
			if (path === '/v2/locations') {
				return json({
					locations: [
						{
							id: merchantId,
							name: 'Sandbox Restaurant',
							currency: catalog.currency,
							timezone: 'America/Los_Angeles',
							phone_number: '+15550199',
							address: {
								address_line_1: '123 Market St',
								locality: 'San Francisco',
								administrative_district_level_1: 'CA',
								postal_code: '94103',
								country: 'US',
							},
							business_hours: {
								periods: [
									{
										day_of_week: 'MON',
										start_local_time: '11:00',
										end_local_time: '21:00',
									},
									{
										day_of_week: 'TUE',
										start_local_time: '11:00',
										end_local_time: '21:00',
									},
								],
							},
						},
					],
				})
			}
			if (path === '/v2/catalog/list') {
				const all = squareWire.encode(
					catalog.items,
					catalog.currency,
					merchantId,
				)
				const offset = Number(url.searchParams.get('cursor') ?? 0)
				return json({
					objects: all.slice(offset, offset + 4),
					...(offset + 4 < all.length ? { cursor: String(offset + 4) } : {}),
				})
			}
			if (path.startsWith('/v2/catalog/object/')) {
				const target = find(path.split('/').pop()!)
				if (!target) return json({ errors: [{ code: 'NOT_FOUND' }] }, 404)
				if (method === 'DELETE') {
					catalog.items = catalog.items.filter((entry) => entry !== target)
					catalog.version++
					return json({ deleted_object_ids: [target.id] })
				}
				const encoded = squareWire.encode(
					[target],
					catalog.currency,
					merchantId,
				)
				return json({
					object: encoded.at(-1),
					related_objects: encoded.slice(0, -1),
				})
			}
			if (path === '/v2/catalog/batch-upsert' && method === 'POST') {
				const data = await body<{
					idempotency_key?: string
					batches?: { objects: unknown[] }[]
				}>()
				if (!data.idempotency_key) {
					return json(
						{
							errors: [
								{
									code: 'MISSING_REQUIRED_PARAMETER',
									field: 'idempotency_key',
								},
							],
						},
						400,
					)
				}
				const incoming = squareWire.decode(
					(data.batches ?? []).flatMap((batch) => batch.objects),
					merchantId,
				)
				const mappings: { client_object_id: string; object_id: string }[] = []
				for (const entry of incoming) {
					if (entry.id.startsWith('#')) {
						const id = `SQUARE_ITEM_${randomUUID().slice(0, 8).toUpperCase()}`
						mappings.push({ client_object_id: entry.id, object_id: id })
						catalog.items.push({
							...entry,
							id,
							variationId: `${id}_VAR`,
							version: 1,
						})
					} else {
						const existing = find(entry.id)
						if (!existing) return json({ errors: [{ code: 'NOT_FOUND' }] }, 404)
						if (existing.version !== entry.version) {
							return json({ errors: [{ code: 'VERSION_MISMATCH' }] }, 409)
						}
						mergeInto(provider, existing, entry)
					}
				}
				catalog.version++
				return json({ id_mappings: mappings })
			}
		}

		if (provider === 'toast') {
			if (path === '/authentication/v1/restaurants') {
				return json({
					restaurants: [
						{
							restaurantGuid: merchantId,
							restaurantName: 'Sandbox Restaurant',
						},
					],
				})
			}
			if (path === '/menus/v2/metadata') {
				return json({
					restaurantGuid: merchantId,
					restaurantName: 'Sandbox Restaurant',
					lastUpdated: new Date().toISOString(),
				})
			}
			if (path === '/menus/v2/menus') {
				return json(toastWire.encode(catalog.items, catalog.menus, merchantId))
			}
			if (path === '/stock/v1/inventory' && method === 'GET') {
				return json(
					catalog.items.map((entry) => ({
						guid: entry.id,
						status: entry.available ? 'IN_STOCK' : 'OUT_OF_STOCK',
					})) as unknown as Record<string, unknown>,
				)
			}
			if (path === '/stock/v1/inventory/update' && method === 'POST') {
				const updates = await body<{ guid: string; status: string }[]>()
				for (const update of updates) {
					if (!find(update.guid)) {
						return json({ message: `Unknown item ${update.guid}` }, 404)
					}
				}
				for (const update of updates) {
					find(update.guid)!.available = update.status !== 'OUT_OF_STOCK'
				}
				return json(updates as unknown as Record<string, unknown>)
			}
		}

		if (provider === 'ubereats') {
			const root = `/v2/eats/stores/${merchantId}`
			if (path === '/v1/eats/stores' && method === 'GET') {
				return json({
					stores: [{ store_id: merchantId, name: 'Sandbox Restaurant' }],
				})
			}
			if (path === root) {
				return json({
					store_id: merchantId,
					name: 'Sandbox Restaurant',
					currency_code: catalog.currency,
					status: 'ACTIVE',
					location: {
						address: '123 Market St',
						city: 'San Francisco',
						state: 'CA',
						postal_code: '94103',
						country: 'US',
					},
				})
			}
			if (path === `${root}/menus` && method === 'GET') {
				return json(uberWire.encode(catalog.items, catalog.menus))
			}
			if (path === `${root}/menus` && method === 'PUT') {
				const decoded = uberWire.decode(await body())
				replaceCatalog(catalog, decoded.items, decoded.menus)
				return noContent()
			}
			const match = path.match(new RegExp(`^${root}/menus/items/([^/]+)$`))
			if (match && method === 'POST') {
				const target = find(match[1]!)
				if (!target) return json({ message: 'Menu item not found' }, 404)
				const data = await body<{
					price_info?: { price?: number }
					suspension_info?: unknown
				}>()
				if (data.price_info?.price !== undefined) {
					target.price = data.price_info.price
				}
				if ('suspension_info' in data) target.available = !data.suspension_info
				target.version++
				return noContent()
			}
		}

		if (provider === 'doordash') {
			const root = `/api/v1/stores/${merchantId}`
			if (path === root) {
				return json({
					store_id: merchantId,
					name: 'Sandbox Restaurant',
					currency: catalog.currency,
					address: '123 Market St',
					city: 'San Francisco',
					state: 'CA',
					zip_code: '94103',
				})
			}
			if (path === `${root}/menus` && method === 'GET') {
				return json({
					store_id: merchantId,
					version: catalog.version,
					menus: doordashWire.encode(catalog.items, catalog.menus),
				})
			}
			if (path === `${root}/menus` && method === 'PUT') {
				const data = await body<{
					base_version?: number
					menus?: unknown[]
				}>()
				if (data.base_version !== catalog.version) {
					return json(
						{
							message:
								'The menu changed since it was read. Re-read and resubmit.',
						},
						409,
					)
				}
				const decoded = doordashWire.decode(data.menus as never[])
				replaceCatalog(catalog, decoded.items, decoded.menus)
				return json(
					{ job_id: `DD_JOB_${catalog.version}`, status: 'PROCESSING' },
					202,
				)
			}
			if (path.startsWith(`${root}/menus/jobs/`)) {
				return json({ job_id: path.split('/').pop(), status: 'COMPLETED' })
			}
			if (path === `${root}/items/status` && method === 'PATCH') {
				const updates =
					await body<{ merchant_supplied_id: string; is_active: boolean }[]>()
				for (const update of updates) {
					if (!find(update.merchant_supplied_id)) {
						return json(
							{ message: `Unknown item ${update.merchant_supplied_id}` },
							404,
						)
					}
				}
				for (const update of updates) {
					find(update.merchant_supplied_id)!.available = update.is_active
				}
				return json({ updated: updates.length })
			}
		}

		return json({ error: 'Unsupported POS endpoint' }, 405)
	})
}

export const posSandboxHandlers = posProviders.map((provider) =>
	handler(provider),
)
