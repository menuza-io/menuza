/**
 * POS adapter factory. One adapter is created per connection and speaks the
 * canonical shapes in `./types` to the provider's HTTP API. Ported from the
 * Mise reference project (`lib/pos/adapters.ts`), trimmed to the five supported
 * platforms (no order/kitchen surface).
 */

import { createHash } from 'node:crypto'
import { PosError } from './errors.ts'
import {
	providerWriteMode,
	type PosProvider,
	type RemoteItem,
	type RemoteMenu,
	type RemoteRead,
} from './types.ts'
import {
	weeklyScheduleFromMenuDays,
	weeklyScheduleFromSquarePeriods,
	type RemoteLocation,
} from './remote-location.ts'
import {
	cloverWire,
	doordashWire,
	squareWire,
	toastWire,
	uberWire,
} from './wire.ts'

export type Transport = {
	baseUrl: string
	token: string
	merchantId: string
	headers?: Record<string, string>
	/** When true, a response that wasn't served by the sandbox is rejected. */
	requireMock?: boolean
	fetch?: typeof fetch
}
type Json = Record<string, unknown>

// Keys derive from what is being written, so a retry of the same write reuses
// its key and the provider can drop the duplicate. Include the remote version
// so a later identical write is new.
export function idempotencyKey(
	...parts: (string | number | boolean | undefined | null)[]
) {
	return createHash('sha256')
		.update(parts.map((part) => String(part ?? '')).join('\u0000'))
		.digest('hex')
		.slice(0, 40)
}

function unauthorizedMessage(provider: PosProvider): string {
	if (provider === 'clover') {
		return (
			'Clover rejected this request. In the Clover Developer Dashboard, open App Settings → Requested Permissions and enable Read merchant and Read inventory (plus Write inventory to push). ' +
			'After changing permissions, disconnect Clover here and connect again so your merchant re-authorizes the app.'
		)
	}
	return 'Authorization expired. Reconnect and try again.'
}

export function createAdapter(provider: PosProvider, config: Transport) {
	async function request<T = Json>(
		path: string,
		init: RequestInit = {},
	): Promise<T> {
		const response = await (config.fetch ?? fetch)(`${config.baseUrl}${path}`, {
			...init,
			cache: 'no-store',
			signal: AbortSignal.timeout(15000),
			headers: {
				Authorization: `Bearer ${config.token}`,
				'Content-Type': 'application/json',
				...(provider === 'square' ? { 'Square-Version': '2026-09-16' } : {}),
				...(provider === 'toast'
					? { 'Toast-Restaurant-External-ID': config.merchantId }
					: {}),
				...config.headers,
				...init.headers,
			},
		})
		if (
			config.requireMock &&
			response.headers.get('x-pos-sandbox') !== 'true'
		) {
			throw new PosError(
				'Sandbox safety check failed: response was not intercepted by the mock server.',
			)
		}
		if (!response.ok) {
			const messages: Record<number, string> = {
				401: unauthorizedMessage(provider),
				429: 'Rate limit reached. We will retry on the next sync.',
				409: 'The menu changed on the provider while syncing. Review the latest changes and try again.',
				503: 'The provider is temporarily unavailable.',
			}
			throw new PosError(
				messages[response.status] ??
					`The provider returned an error (${response.status}). No changes were marked as synced.`,
				response.status,
			)
		}
		if (response.status === 204) return {} as T
		const body = await response.text()
		if (!body) {
			throw new PosError(
				'The provider returned an empty response. No changes were marked as synced.',
				response.status,
			)
		}
		try {
			return JSON.parse(body) as T
		} catch {
			throw new PosError(
				'The provider returned an unreadable response. No changes were marked as synced.',
				response.status,
			)
		}
	}

	// Menu ingestion is asynchronous, so a submission only counts once the
	// provider confirms the job.
	async function waitForJob(path: string) {
		for (let attempt = 0; attempt < 20; attempt++) {
			const job = await request<{ status: string }>(path)
			if (job.status === 'COMPLETED') return
			if (job.status === 'FAILED') {
				throw new PosError('The provider rejected the menu update.')
			}
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
		throw new PosError(
			'The provider did not confirm the update in time. No changes were marked as synced.',
		)
	}

	const m = encodeURIComponent(config.merchantId)
	const clover = `/v3/merchants/${m}`
	const uber = `/v2/eats/stores/${m}`
	const doordash = `/api/v1/stores/${m}`

	async function read(): Promise<RemoteRead> {
		if (provider === 'clover') {
			const { currency } = await request<{ currency: string }>(clover)
			const items: RemoteItem[] = []
			for (let offset = 0, page = 0; page < 100; page++) {
				const data = await request<{ elements: Json[] }>(
					`${clover}/items?expand=categories,modifierGroups.modifiers,taxRates&limit=100&offset=${offset}`,
				)
				items.push(...data.elements.map(cloverWire.decode))
				if (data.elements.length < 100) {
					return { items, menus: [], version: 0, currency }
				}
				offset += data.elements.length
			}
			throw new PosError(
				'Catalog exceeds the safe pagination limit. Nothing was imported.',
			)
		}
		if (provider === 'square') {
			const { locations } = await request<{
				locations: { currency: string }[]
			}>('/v2/locations')
			const objects: Json[] = []
			let cursor: string | undefined
			for (let page = 0; page < 200; page++) {
				const data = await request<{ objects?: Json[]; cursor?: string }>(
					`/v2/catalog/list?types=ITEM,CATEGORY,MODIFIER_LIST,TAX,IMAGE${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
				)
				objects.push(...(data.objects ?? []))
				cursor = data.cursor
				if (!cursor) {
					return {
						items: squareWire.decode(objects, config.merchantId),
						menus: [],
						version: 0,
						currency: locations[0]?.currency ?? 'USD',
					}
				}
			}
			throw new PosError(
				'Catalog exceeds the safe pagination limit. Nothing was imported.',
			)
		}
		if (provider === 'toast') {
			const [menus, stock] = await Promise.all([
				request('/menus/v2/menus'),
				request<Json[]>('/stock/v1/inventory'),
			])
			return { ...toastWire.decode(menus, stock), version: 0, currency: 'USD' }
		}
		if (provider === 'ubereats') {
			const [store, menu] = await Promise.all([
				request<{ currency_code: string }>(uber),
				request(`${uber}/menus`),
			])
			return {
				...uberWire.decode(menu),
				version: 0,
				currency: store.currency_code,
			}
		}
		const [store, data] = await Promise.all([
			request<{ currency: string }>(doordash),
			request<{ version: number; menus: Json[] }>(`${doordash}/menus`),
		])
		return {
			...doordashWire.decode(data.menus),
			version: data.version,
			currency: store.currency,
		}
	}

	async function readLocation(): Promise<RemoteLocation | null> {
		if (provider === 'clover') {
			const merchant = await request<{
				name?: string
				phoneNumber?: string
				address?: {
					address1?: string
					city?: string
					state?: string
					zip?: string
					country?: string
				}
			}>(clover)
			const address = merchant.address
			return {
				name: merchant.name ?? 'Restaurant',
				phone: merchant.phoneNumber ?? null,
				timezone: 'America/New_York',
				remoteLocationId: config.merchantId,
				address: address
					? {
							formattedAddress: [
								address.address1,
								address.city,
								address.state,
								address.zip,
							]
								.filter(Boolean)
								.join(', '),
							city: address.city ?? '',
							state: address.state ?? '',
							postalCode: address.zip ?? '',
							country: address.country ?? 'US',
							lat: 0,
							lng: 0,
						}
					: null,
			}
		}
		if (provider === 'square') {
			const { locations } = await request<{
				locations: {
					id: string
					name?: string
					phone_number?: string
					timezone?: string
					address?: {
						address_line_1?: string
						locality?: string
						administrative_district_level_1?: string
						postal_code?: string
						country?: string
					}
					business_hours?: { periods?: unknown[] }
				}[]
			}>('/v2/locations')
			const location =
				locations.find((entry) => entry.id === config.merchantId) ??
				locations[0]
			if (!location) return null
			const address = location.address
			const periods = (location.business_hours?.periods ?? []) as {
				day_of_week?: string
				start_local_time?: string
				end_local_time?: string
			}[]
			return {
				name: location.name ?? 'Restaurant',
				phone: location.phone_number ?? null,
				timezone: location.timezone ?? 'America/New_York',
				remoteLocationId: location.id,
				address: address
					? {
							formattedAddress: [
								address.address_line_1,
								address.locality,
								address.administrative_district_level_1,
								address.postal_code,
							]
								.filter(Boolean)
								.join(', '),
							city: address.locality ?? '',
							state: address.administrative_district_level_1 ?? '',
							postalCode: address.postal_code ?? '',
							country: address.country ?? 'US',
							lat: 0,
							lng: 0,
						}
					: null,
				storeHours: periods.length
					? weeklyScheduleFromSquarePeriods(periods)
					: null,
			}
		}
		if (provider === 'toast') {
			const meta = await request<{
				restaurantGuid?: string
				restaurantName?: string
			}>('/menus/v2/metadata')
			const catalog = await read()
			const menu = catalog.menus[0]
			return {
				name: meta.restaurantName ?? 'Restaurant',
				remoteLocationId: meta.restaurantGuid ?? config.merchantId,
				timezone: menu?.timezone ?? 'America/New_York',
				onlineHours: menu
					? weeklyScheduleFromMenuDays(menu.days, menu.start, menu.end)
					: null,
			}
		}
		if (provider === 'ubereats') {
			const store = await request<{
				name?: string
				location?: {
					address?: string
					city?: string
					state?: string
					postal_code?: string
					country?: string
				}
			}>(uber)
			const catalog = await read()
			const menu = catalog.menus[0]
			const loc = store.location
			return {
				name: store.name ?? 'Restaurant',
				remoteLocationId: config.merchantId,
				address: loc
					? {
							formattedAddress: [
								loc.address,
								loc.city,
								loc.state,
								loc.postal_code,
							]
								.filter(Boolean)
								.join(', '),
							city: loc.city ?? '',
							state: loc.state ?? '',
							postalCode: loc.postal_code ?? '',
							country: loc.country ?? 'US',
							lat: 0,
							lng: 0,
						}
					: null,
				onlineHours: menu
					? weeklyScheduleFromMenuDays(menu.days, menu.start, menu.end)
					: null,
			}
		}
		const store = await request<{
			name?: string
			address?: string
			city?: string
			state?: string
			zip_code?: string
		}>(doordash)
		const catalog = await read()
		const menu = catalog.menus[0]
		return {
			name: store.name ?? 'Restaurant',
			remoteLocationId: config.merchantId,
			address: store.address
				? {
						formattedAddress: [
							store.address,
							store.city,
							store.state,
							store.zip_code,
						]
							.filter(Boolean)
							.join(', '),
						city: store.city ?? '',
						state: store.state ?? '',
						postalCode: store.zip_code ?? '',
						country: 'US',
						lat: 0,
						lng: 0,
					}
				: null,
			onlineHours: menu
				? weeklyScheduleFromMenuDays(menu.days, menu.start, menu.end)
				: null,
		}
	}

	return {
		writeMode: providerWriteMode[provider],
		async connect() {
			return (await read()).currency
		},
		read,
		readLocation,
		// Item-level providers: Clover and Square.
		async create(
			item: RemoteItem,
			key: string,
			currency: string,
		): Promise<RemoteItem> {
			if (provider === 'clover') {
				const { id: _id, ...element } = cloverWire.encode({ ...item, id: '' })
				return cloverWire.decode(
					await request(`${clover}/items`, {
						method: 'POST',
						body: JSON.stringify(element),
					}),
				)
			}
			if (provider === 'square') {
				const draft = {
					...item,
					id: `#${key.slice(0, 8)}`,
					variationId: undefined,
				}
				const result = await request<{
					id_mappings: { client_object_id: string; object_id: string }[]
				}>('/v2/catalog/batch-upsert', {
					method: 'POST',
					body: JSON.stringify({
						idempotency_key: key,
						batches: [
							{
								objects: squareWire.encode(
									[draft],
									currency,
									config.merchantId,
								),
							},
						],
					}),
				})
				const id = result.id_mappings.find(
					(entry) => entry.client_object_id === draft.id,
				)?.object_id
				if (!id)
					throw new PosError('Square did not return an ID for the new item.')
				return { ...item, id, variationId: `${id}_VAR`, version: 1 }
			}
			throw new PosError(
				`${provider} does not accept single-item creates.`,
				400,
			)
		},
		async update(item: RemoteItem, key: string, currency: string) {
			if (provider === 'clover') {
				return void (await request(
					`${clover}/items/${encodeURIComponent(item.id)}`,
					{ method: 'POST', body: JSON.stringify(cloverWire.encode(item)) },
				))
			}
			if (provider === 'square') {
				return void (await request('/v2/catalog/batch-upsert', {
					method: 'POST',
					body: JSON.stringify({
						idempotency_key: key,
						batches: [
							{
								objects: squareWire.encode([item], currency, config.merchantId),
							},
						],
					}),
				}))
			}
			throw new PosError(
				`${provider} does not accept single-item updates.`,
				400,
			)
		},
		async remove(id: string) {
			if (provider === 'clover') {
				return void (await request(
					`${clover}/items/${encodeURIComponent(id)}`,
					{
						method: 'DELETE',
					},
				))
			}
			if (provider === 'square') {
				return void (await request(
					`/v2/catalog/object/${encodeURIComponent(id)}`,
					{ method: 'DELETE' },
				))
			}
			throw new PosError(
				`${provider} removes items through a full-menu update.`,
				400,
			)
		},
		// Menu-level providers replace the whole menu, so callers must pass every
		// item the provider should keep.
		async submitMenu(
			items: RemoteItem[],
			menus: RemoteMenu[],
			baseVersion: number,
			key: string,
		) {
			if (provider === 'ubereats') {
				return void (await request(`${uber}/menus`, {
					method: 'PUT',
					body: JSON.stringify(uberWire.encode(items, menus)),
				}))
			}
			if (provider === 'doordash') {
				const { job_id } = await request<{ job_id: string }>(
					`${doordash}/menus`,
					{
						method: 'PUT',
						body: JSON.stringify({
							base_version: baseVersion,
							idempotency_key: key,
							menus: doordashWire.encode(items, menus),
						}),
					},
				)
				return waitForJob(
					`${doordash}/menus/jobs/${encodeURIComponent(job_id)}`,
				)
			}
			throw new PosError(
				`${provider} does not accept full-menu submissions.`,
				400,
			)
		},
		// Every provider has a dedicated availability endpoint, so sold-out
		// changes never resubmit a menu.
		async pause(until: string | null) {
			const path =
				provider === 'clover'
					? `${clover}/store/pause`
					: provider === 'square'
						? '/v2/locations/pause'
						: provider === 'toast'
							? '/restaurant/pause'
							: provider === 'ubereats'
								? `${uber}/pause`
								: `${doordash}/pause`
			await request(path, {
				method: 'POST',
				body: JSON.stringify({ until }),
			})
		},
		async setAvailability(
			item: RemoteItem,
			available: boolean,
			key: string,
			currency: string,
		) {
			if (provider === 'clover') {
				return void (await request(
					`${clover}/items/${encodeURIComponent(item.id)}`,
					{
						method: 'POST',
						body: JSON.stringify({ available }),
					},
				))
			}
			if (provider === 'square') {
				return void (await request('/v2/catalog/batch-upsert', {
					method: 'POST',
					body: JSON.stringify({
						idempotency_key: key,
						batches: [
							{
								objects: squareWire.encode(
									[{ ...item, available }],
									currency,
									config.merchantId,
								),
							},
						],
					}),
				}))
			}
			if (provider === 'toast') {
				return void (await request('/stock/v1/inventory/update', {
					method: 'POST',
					body: JSON.stringify([
						{ guid: item.id, status: available ? 'IN_STOCK' : 'OUT_OF_STOCK' },
					]),
				}))
			}
			if (provider === 'ubereats') {
				return void (await request(
					`${uber}/menus/items/${encodeURIComponent(item.id)}`,
					{
						method: 'POST',
						body: JSON.stringify({
							suspension_info: available
								? null
								: { suspension: { suspend_until: 0, reason: 'Sold out' } },
						}),
					},
				))
			}
			return void (await request(`${doordash}/items/status`, {
				method: 'PATCH',
				body: JSON.stringify([
					{ merchant_supplied_id: item.id, is_active: available },
				]),
			}))
		},
	}
}
export type Adapter = ReturnType<typeof createAdapter>
