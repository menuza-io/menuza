import { countEntriesResultSchema, type SendOrderResult } from '@repo/inventory'
import {
	createCountQueue,
	type EntryStore,
	type QueuedEntry,
} from '../count-queue'
import { uploadInvoicePhoto } from '../invoice-photo'
import {
	approveOrder,
	createDraftFromSuggestion,
	sendOrder,
} from '../order-flow'
import { createRegionClient, type InventoryAccess } from '../region-client'

/**
 * The manager's flow from the phone (#516) against a stand-in regional node:
 * count (offline first), receive with an invoice photo, and approve and send a
 * suggested order. Every call goes to the node with the short-lived token; the
 * phone's helpers parse every answer with the shared contract.
 */

const access: InventoryAccess = {
	jwt: 'inv-jwt',
	tenantApiUrl: 'https://us.tenant.example',
	scope: 'write',
	grants: [
		'read:inventory:any',
		'update:inventory:any',
		'update:inventory_purchasing:any',
	],
	features: {
		enabled: true,
		purchasing: true,
		recipes: false,
		prep: false,
		transfers: false,
	},
	expiresAt: 10 * 60_000,
	organizationId: 'org_12345678',
	currency: 'USD',
	canManageSettings: true,
	locations: [{ id: 'loc_a', name: 'Downtown' }],
}

type Body = Record<string, unknown> & { entries?: QueuedEntry[] }
type Call = { method: string; path: string; body: Body | null; auth: string }

function node(options: { online: () => boolean }) {
	const calls: Call[] = []
	const respond = (status: number, body: unknown) =>
		({
			ok: status < 300,
			status,
			text: async () => JSON.stringify(body),
		}) as Response
	const order = (extra: Record<string, unknown> = {}) => ({
		id: 'ord_1',
		number: 7,
		locationId: 'loc_a',
		supplierId: 'sup_1',
		supplierName: 'Fresh Farms',
		supplierOrderChannel: 'email',
		supplierEmail: 'orders@farms.test',
		supplierPhone: '+15550100',
		status: 'draft',
		expectedDate: '2026-11-25',
		cutoff: null,
		note: null,
		createdBy: { kind: 'operator', id: 'user_1' },
		createdAt: 1,
		sentAt: null,
		sentVia: null,
		closedAt: null,
		lineCount: 1,
		receivedLineCount: 0,
		version: 1,
		lines: [],
		deliveries: [],
		...extra,
	})
	const sent = (channel: string): SendOrderResult =>
		({
			locale: 'en',
			subject: 'Order 7',
			text: 'Order text',
			waLink: null,
			mailto: null,
			order: order({ status: 'sent', version: 2 }),
			channel,
			emailSent: true,
			emailSkipped: null,
		}) as unknown as SendOrderResult
	const fetchImpl = (async (url: string, init: RequestInit) => {
		if (!options.online()) throw new TypeError('Network request failed')
		const path = url.replace('https://us.tenant.example/operator/inventory', '')
		const body: Body | null = init.body ? JSON.parse(String(init.body)) : null
		const headers = init.headers as Record<string, string>
		calls.push({
			method: init.method ?? 'GET',
			path,
			body,
			auth: headers.Authorization ?? '',
		})
		if (path === '/counts/cnt_1/entries') {
			return respond(200, {
				accepted: (body?.entries ?? []).map((entry) => ({
					clientId: entry.clientId,
					quantity: 1000,
				})),
				duplicates: [],
				refused: [],
			})
		}
		if (path === '/counts/cnt_1/send') {
			return respond(200, { id: 'cnt_1', status: 'in_review' })
		}
		if (path === '/orders') return respond(200, order())
		if (path === '/orders/ord_1/send')
			return respond(200, sent(String(body?.channel)))
		if (path === '/orders/ord_2/approve')
			return respond(200, sent(String(body?.channel)))
		if (path === '/deliveries/dlv_1/invoice-photo') {
			return respond(200, {
				key: 'inventory-invoices/org/dlv_1/p1.jpg',
				method: 'PUT',
				uploadUrl: 'https://storage.example/upload',
				headers: { 'Content-Type': 'image/jpeg' },
				expiresAt: 99,
				maxBytes: 5_000_000,
			})
		}
		if (path === '/deliveries/dlv_1/invoice-photo/confirm') {
			return respond(200, { id: 'dlv_1' })
		}
		return respond(404, { code: 'not_found' })
	}) as unknown as typeof fetch
	return { calls, fetchImpl }
}

function memoryStore(): EntryStore {
	let saved: QueuedEntry[] = []
	return {
		async load() {
			return saved
		},
		async save(entries) {
			saved = entries
		},
	}
}

describe('a manager counts, receives and orders from the phone (#516)', () => {
	it('syncs count entries made offline later, reporting what the phone still held', async () => {
		let online = false
		const { calls, fetchImpl } = node({ online: () => online })
		const client = createRegionClient({
			organizationId: access.organizationId,
			fetchAccess: async () => access,
			fetchImpl,
			now: () => 0,
		})
		const queue = createCountQueue({
			store: memoryStore(),
			send: async (batch, unsent) =>
				countEntriesResultSchema.parse(
					await client.request('/counts/cnt_1/entries', {
						method: 'POST',
						write: true,
						body: {
							entries: batch.map(({ queuedAt: _q, ...entry }) => entry),
							device: { id: 'phone-device-1', kind: 'phone', unsent },
						},
					}),
				),
		})
		// In the walk-in, no signal: both entries are kept on the phone.
		await queue.submit({
			clientId: 'e-1',
			itemId: 'i-1',
			areaId: 'a-1',
			amount: 4,
			unit: 'kg',
		})
		await queue.submit({
			clientId: 'e-2',
			itemId: 'i-2',
			areaId: 'a-1',
			amount: 2,
			unit: 'kg',
		})
		expect(queue.getState().pending).toHaveLength(2)
		expect(calls).toEqual([])

		// Back at the counter: they sync, and the node saw the device and what it held.
		online = true
		await queue.flush()
		expect(queue.getState().pending).toEqual([])
		expect(calls).toHaveLength(1)
		expect(calls[0]).toMatchObject({
			method: 'POST',
			path: '/counts/cnt_1/entries',
			auth: 'Bearer inv-jwt',
			body: { device: { id: 'phone-device-1', kind: 'phone', unsent: 0 } },
		})
		expect(calls[0]!.body!.entries!.map((e) => e.clientId)).toEqual([
			'e-1',
			'e-2',
		])
		await client.request('/counts/cnt_1/send', {
			method: 'POST',
			write: true,
			body: { expectedVersion: 1 },
		})
		expect(calls.at(-1)).toMatchObject({ path: '/counts/cnt_1/send' })
	})

	it('receives a delivery and attaches the invoice photo straight to storage', async () => {
		const { calls, fetchImpl } = node({ online: () => true })
		const client = createRegionClient({
			organizationId: access.organizationId,
			fetchAccess: async () => access,
			fetchImpl,
			now: () => 0,
		})
		const puts: Array<{ url: string; headers: Record<string, string> }> = []
		await uploadInvoicePhoto({
			client,
			deliveryId: 'dlv_1',
			photo: {
				uri: 'file:///invoice.jpg',
				contentType: 'image/jpeg',
				sizeBytes: 120_000,
			},
			put: async (url, headers) => {
				puts.push({ url, headers })
				return 200
			},
		})
		expect(calls.map((call) => call.path)).toEqual([
			'/deliveries/dlv_1/invoice-photo',
			'/deliveries/dlv_1/invoice-photo/confirm',
		])
		expect(calls[0]!.body).toEqual({
			contentType: 'image/jpeg',
			sizeBytes: 120_000,
		})
		expect(puts).toEqual([
			{
				url: 'https://storage.example/upload',
				headers: { 'Content-Type': 'image/jpeg' },
			},
		])
		// A file the region would refuse never leaves the phone.
		await expect(
			uploadInvoicePhoto({
				client,
				deliveryId: 'dlv_1',
				photo: {
					uri: 'file:///x.gif',
					contentType: 'image/gif',
					sizeBytes: 10,
				},
				put: async () => 200,
			}),
		).rejects.toMatchObject({ code: 'unsupported_media_type' })
	})

	it('approves and sends a suggested order, and approves one that waited for a manager', async () => {
		const { calls, fetchImpl } = node({ online: () => true })
		const client = createRegionClient({
			organizationId: access.organizationId,
			fetchAccess: async () => access,
			fetchImpl,
			now: () => 0,
		})
		const draft = await createDraftFromSuggestion({
			client,
			clientId: 'draft-client-1',
			locationId: 'loc_a',
			supplierId: 'sup_1',
		})
		expect(draft).toMatchObject({ id: 'ord_1', status: 'draft' })
		const sentOrder = await sendOrder({
			client,
			orderId: draft.id,
			expectedVersion: draft.version,
			channel: 'email',
			locale: 'en',
		})
		expect(sentOrder.order.status).toBe('sent')
		await approveOrder({
			client,
			orderId: 'ord_2',
			expectedVersion: 3,
			channel: 'whatsapp',
			locale: 'ar',
		})
		expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
			'POST /orders',
			'POST /orders/ord_1/send',
			'POST /orders/ord_2/approve',
		])
		expect(calls[0]!.body).toMatchObject({
			clientId: 'draft-client-1',
			locationId: 'loc_a',
			supplierId: 'sup_1',
			fromSuggestion: true,
		})
	})
})
