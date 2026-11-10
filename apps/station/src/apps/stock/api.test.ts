import 'fake-indexeddb/auto'
import {
	classifyStationFailure,
	INVENTORY_POS_CONTRACT_VERSION,
	INVENTORY_POS_ERROR_CODES,
	STATION_ERROR_HANDLING,
} from '@repo/inventory'
import { describe, expect, it, vi } from 'vitest'
import {
	createStockApi,
	PHOTO_UNREACHABLE,
	STOCK_CONTRACT_VERSION,
	type StockApiError,
} from './api.ts'
import catalogFixture from './fixtures/catalog.json'
import countEntries from './fixtures/count-entries.json'
import countSheet from './fixtures/count-sheet.json'
import delivery from './fixtures/delivery.json'
import photoUpload from './fixtures/photo-upload.json'
import startCount from './fixtures/start-count.json'
import waste from './fixtures/waste.json'
import { session, settings } from './testing.ts'

const api = (fetchImpl: typeof fetch, over = {}) =>
	createStockApi({ ...settings, ...over }, session(), fetchImpl)

const respond = (body: unknown, init: ResponseInit = {}) =>
	vi.fn(async () => Response.json(body, init)) as unknown as typeof fetch & {
		mock: { calls: Array<[string, RequestInit]> }
	}

describe('the Stock client', () => {
	it('talks to the regional node directly with the device secret, the staff session and the contract version, never cookies or the cache', async () => {
		const fetchImpl = respond(catalogFixture)
		await api(fetchImpl).catalog('main', null)
		const [url, init] = fetchImpl.mock.calls[0]!
		expect(url).toBe('https://api.test/pos/inventory/catalog?locationId=main')
		expect(init).toMatchObject({
			method: 'GET',
			cache: 'no-store',
			credentials: 'omit',
		})
		expect(init.headers).toEqual({
			Authorization: 'Bearer device-secret',
			'Pos-Inventory-Contract': '2',
			'Pos-Staff-Session': 'staff-session-token-aaaaaaaa',
		})
	})

	it('speaks contract version 2 (never older than the shared package)', () => {
		expect(STOCK_CONTRACT_VERSION).toBe(2)
		expect(STOCK_CONTRACT_VERSION).toBeGreaterThanOrEqual(
			INVENTORY_POS_CONTRACT_VERSION,
		)
	})

	it('reads a contract_unsupported refusal as that code, for "Update Station"', async () => {
		await expect(
			api(respond({ error: 'contract_unsupported' }, { status: 400 })).catalog(
				'main',
				null,
			),
		).rejects.toMatchObject({ code: 'contract_unsupported', status: 400 })
	})

	it('a 200 answer its schemas cannot read is invalid_response, not a refusal the person did anything about', async () => {
		await expect(
			api(respond({ accepted: 'nope' })).countEntries('cnt_1', {
				entries: [
					{
						clientId: 'entry-0001-aaaa',
						itemId: 'item_tomato',
						areaId: null,
						amount: 1,
						unit: 'kg',
					},
				],
			}),
		).rejects.toMatchObject({ code: 'invalid_response', status: 502 })
	})

	it('asks for the catalogue conditionally and understands a 304 (no body)', async () => {
		const fetchImpl = vi.fn(
			async () => new Response(null, { status: 304 }),
		) as unknown as typeof fetch & {
			mock: { calls: Array<[string, RequestInit]> }
		}
		const answer = await api(fetchImpl).catalog('main', 'cat-7f3a91c2e4b8')
		expect(answer).toEqual({ status: 'not_modified' })
		expect(
			(fetchImpl.mock.calls[0]![1].headers as Record<string, string>)[
				'If-None-Match'
			],
		).toBe('"cat-7f3a91c2e4b8"')
	})

	it('parses every recorded answer with the contract’s schemas', async () => {
		expect(
			(await api(respond(catalogFixture)).catalog('main', null)).status,
		).toBe('ok')
		await expect(
			api(respond(startCount)).startCount({
				clientId: 'start-0001-aaaa',
				locationId: 'main',
				listId: null,
			}),
		).resolves.toMatchObject({ joined: true })
		await expect(
			api(respond(countSheet)).countSheet('cnt_open1'),
		).resolves.toMatchObject({ areas: expect.any(Array) })
		await expect(
			api(respond(countEntries)).countEntries('cnt_open1', {
				entries: [
					{
						clientId: 'entry-0001-aaaa',
						itemId: 'item_tomato',
						areaId: null,
						amount: 1,
						unit: 'kg',
					},
				],
			}),
		).resolves.toMatchObject({ duplicates: ['entry-0003-cccc'] })
		await expect(
			api(respond(waste)).waste({
				entries: [
					{
						clientId: 'waste-0001-aaaa',
						locationId: 'main',
						itemId: 'item_tomato',
						amount: 1,
						unit: 'kg',
						reason: 'spoiled',
					},
				],
			}),
		).resolves.toMatchObject({ lateSync: ['waste-0001-aaaa'] })
		await expect(
			api(respond(delivery)).delivery({
				clientId: 'deliv-0001-aaaa',
				locationId: 'main',
				supplierId: 'sup_fresh',
				lines: [{ itemId: 'item_tomato', quantity: 6_000_000 }],
			}),
		).resolves.toMatchObject({ pricesPending: true })
		await expect(
			api(respond(photoUpload)).photoRequest('dlv_9', {
				contentType: 'image/jpeg',
				sizeBytes: 1000,
			}),
		).resolves.toMatchObject({ method: 'PUT' })
	})

	it('refuses to send a request the region would refuse, without a round trip or echoing the value', async () => {
		const fetchImpl = respond({})
		await expect(
			api(fetchImpl).waste({
				entries: [
					{
						clientId: 'waste-0001-aaaa',
						locationId: 'main',
						itemId: 'item_tomato',
						amount: -5,
						unit: 'kg',
						reason: 'spoiled',
					},
				],
			}),
		).rejects.toMatchObject({ code: 'invalid_request', status: 400 })
		await expect(
			api(fetchImpl).waste({
				entries: [
					{
						clientId: 'waste-0001-aaaa',
						locationId: 'main',
						itemId: 'item_tomato',
						amount: 1,
						unit: 'kg',
						// The system reasons are not for a tablet to pick.
						reason: 'remade_at_till',
						// @ts-expect-error money is not a field of this request
						valueMinor: 100,
					},
				],
			}),
		).rejects.toMatchObject({ code: 'invalid_request' })
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('turns refusals into errors the outbox can classify, and a captive portal into a retry', async () => {
		await expect(
			api(respond({ error: 'count_closed' }, { status: 409 })).sendCount(
				'cnt_1',
				{
					clientId: 'send-0001-aaaa',
				},
			),
		).rejects.toMatchObject({ code: 'count_closed', status: 409 })
		const portal = vi.fn(
			async () => new Response('<html>log in</html>', { status: 200 }),
		) as unknown as typeof fetch
		const error = await api(portal)
			.catalog('main', null)
			.catch((failure: unknown) => failure)
		expect(error).toMatchObject({ code: 'invalid_response', status: 502 })
		expect(
			classifyStationFailure({
				status: (error as StockApiError).status,
				code: (error as StockApiError).code,
			}),
		).toBe('retry')
		const offline = vi.fn(async () => {
			throw new TypeError('Failed to fetch')
		}) as unknown as typeof fetch
		await expect(api(offline).catalog('main', null)).rejects.toMatchObject({
			code: 'connection_lost',
			status: 0,
		})
	})

	it('refuses an unpaired tablet before any request', async () => {
		const fetchImpl = respond({})
		await expect(
			api(fetchImpl, { deviceToken: null }).catalog('main', null),
		).rejects.toMatchObject({ code: 'invalid_device', status: 401 })
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('puts a photo straight into the storage the region named, with the signed headers and nothing of ours', async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }))
		const blob = new Blob(['bytes'], { type: 'image/jpeg' })
		await api(fetchImpl as unknown as typeof fetch).putPhoto(
			photoUpload as never,
			blob,
		)
		const [url, init] = fetchImpl.mock.calls[0]! as unknown as [
			string,
			RequestInit,
		]
		expect(url).toBe(photoUpload.uploadUrl)
		expect(init).toMatchObject({
			method: 'PUT',
			credentials: 'omit',
			headers: photoUpload.headers,
			body: blob,
		})
		const refused = vi.fn(async () => new Response(null, { status: 403 }))
		await expect(
			api(refused as unknown as typeof fetch).putPhoto(
				photoUpload as never,
				blob,
			),
		).rejects.toMatchObject({ code: 'upload_failed', status: 403 })
	})

	it('a browser PUT that fails (no network, or a bucket with no CORS) is photo_unreachable, which only the photo waits for', async () => {
		const blocked = vi.fn(async () => {
			throw new TypeError('Failed to fetch')
		})
		const error = await api(blocked as unknown as typeof fetch)
			.putPhoto(photoUpload as never, new Blob(['bytes']))
			.catch((failure: unknown) => failure)
		expect(error).toMatchObject({ code: PHOTO_UNREACHABLE, status: 0 })
		expect(
			classifyStationFailure({
				status: (error as StockApiError).status,
				code: (error as StockApiError).code,
			}),
		).toBe('retry')
	})
})

describe('what the tablet does with each code of the contract', () => {
	it('knows every code and acts on it as the contract says', () => {
		for (const code of INVENTORY_POS_ERROR_CODES) {
			const known = STATION_ERROR_HANDLING[code]
			expect(classifyStationFailure({ status: known.status, code })).toBe(
				known.action,
			)
		}
	})

	it('treats an unknown code by its status: outages retry, other refusals are permanent', () => {
		expect(classifyStationFailure({ status: 0 })).toBe('retry')
		expect(classifyStationFailure({ status: 502, code: 'new_thing' })).toBe(
			'retry',
		)
		expect(classifyStationFailure({ status: 422, code: 'new_thing' })).toBe(
			'permanent',
		)
	})
})
