import {
	orderDetailSchema,
	sendOrderResultSchema,
	type SendOrderResult,
} from '@repo/inventory'
import { type RegionClient } from './region-client'

/**
 * "Approve and send a suggested order" from the phone (#516), as the web does
 * it: a draft is made from the current suggestion for one supplier, then sent
 * by the channel the person picks. Every request carries a client id (the
 * region replays the first answer), so a double tap or a retry after a dropped
 * signal never makes a second order. An order over a spending limit waits for
 * a manager's approval instead of going out; `approveOrder` is that decision.
 */

export type SendChannel = 'email' | 'whatsapp' | 'copy'

export async function createDraftFromSuggestion(input: {
	client: RegionClient
	clientId: string
	locationId: string
	supplierId: string
}) {
	return orderDetailSchema.parse(
		await input.client.request('/orders', {
			method: 'POST',
			write: true,
			body: {
				clientId: input.clientId,
				locationId: input.locationId,
				supplierId: input.supplierId,
				fromSuggestion: true,
			},
		}),
	)
}

export async function sendOrder(input: {
	client: RegionClient
	orderId: string
	expectedVersion: number
	channel: SendChannel
	locale: 'en' | 'ar'
}): Promise<SendOrderResult> {
	return sendOrderResultSchema.parse(
		await input.client.request(
			`/orders/${encodeURIComponent(input.orderId)}/send`,
			{
				method: 'POST',
				write: true,
				body: {
					expectedVersion: input.expectedVersion,
					channel: input.channel,
					locale: input.locale,
				},
			},
		),
	)
}

export async function approveOrder(input: {
	client: RegionClient
	orderId: string
	expectedVersion: number
	channel: SendChannel
	locale: 'en' | 'ar'
}): Promise<SendOrderResult> {
	return sendOrderResultSchema.parse(
		await input.client.request(
			`/orders/${encodeURIComponent(input.orderId)}/approve`,
			{
				method: 'POST',
				write: true,
				body: {
					expectedVersion: input.expectedVersion,
					channel: input.channel,
					locale: input.locale,
				},
			},
		),
	)
}
