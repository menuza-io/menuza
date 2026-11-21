import {
	type CustomerOrderListItem,
	reorderResponseSchema,
	type ReorderResponse,
} from '@repo/common/customer-orders'
import { z } from 'zod'
import { type CustomerSession } from '../session/customer-session'
import { buildUrl, decodeResponse, performRequest } from './request'

const listItemSchema = z.object({
	id: z.string(),
	number: z.string(),
	status: z.string(),
	paymentStatus: z.string(),
	paymentMethod: z.string(),
	fulfillment: z.string(),
	currency: z.string(),
	totalCents: z.number(),
	createdAt: z.string().nullable(),
	location: z.object({ id: z.string(), name: z.string() }),
	itemCount: z.number(),
	itemNames: z.array(z.string()),
	isDrop: z.boolean(),
	canReorder: z.boolean(),
	canFinish: z.boolean(),
}) satisfies z.ZodType<CustomerOrderListItem>

const pageSchema = z.object({
	orders: z.array(listItemSchema),
	nextCursor: z.string().nullable(),
})

const receiptLineSchema = z.object({
	itemName: z.string(),
	quantity: z.number(),
	totalCents: z.number(),
	variantNames: z.array(z.string()).optional(),
	options: z
		.array(z.object({ optionName: z.string(), quantity: z.number() }))
		.optional(),
})

const receiptSchema = z.object({
	order: z.object({
		id: z.string(),
		number: z.string(),
		status: z.string(),
		currency: z.string(),
		subtotalCents: z.number(),
		taxCents: z.number(),
		totalCents: z.number(),
		createdAt: z.string().nullable(),
		location: z.object({ id: z.string(), name: z.string() }),
		lines: z.array(receiptLineSchema),
	}),
})

export type CustomerOrderReceipt = z.infer<typeof receiptSchema>['order']
export type CustomerOrdersPage = z.infer<typeof pageSchema>

/**
 * The guest's own restaurant orders (#112): `GET /customer/orders`,
 * `/customer/orders/:id` and `/customer/orders/:id/reorder` on the regional
 * tenant-api, straight from the app with the customer token. Another guest's
 * order id is a 404, like one that does not exist.
 */
export class CustomerOrdersClient {
	readonly #session: CustomerSession

	constructor(session: CustomerSession) {
		this.#session = session
	}

	list(cursor?: string | null): Promise<CustomerOrdersPage> {
		const path = '/customer/orders'
		return this.#get(path, cursor ? [['cursor', cursor]] : []).then(
			(response) => decodeResponse(response, pageSchema, path),
		)
	}

	get(id: string): Promise<CustomerOrderReceipt> {
		const path = `/customer/orders/${encodeURIComponent(id)}`
		return this.#get(path).then(
			(response) => decodeResponse(response, receiptSchema, path).order,
		)
	}

	reorder(id: string): Promise<ReorderResponse> {
		const path = `/customer/orders/${encodeURIComponent(id)}/reorder`
		return this.#get(path).then((response) =>
			decodeResponse(response, reorderResponseSchema, path),
		)
	}

	#get(path: string, query: Array<[string, string]> = []) {
		return this.#session.authorized((token) => {
			const client = this.#session.client
			return performRequest(client.transport, {
				method: 'GET',
				url: buildUrl(client.regionalBaseUrl(), path, query),
				headers: {
					Accept: 'application/json',
					Authorization: `Bearer ${token}`,
				},
				timeoutMs: client.configuration.requestTimeoutMs,
			})
		})
	}
}
