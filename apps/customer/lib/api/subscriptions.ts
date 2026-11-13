import { z } from 'zod'
import { type CustomerSession } from '../session/customer-session'
import { ApiError } from './api-error'
import { buildUrl, decodeResponse, performRequest } from './request'

export type SubscriptionTopic =
	'marketing' | 'product_updates' | 'drops' | 'reservations'
export type SubscriptionChannel = 'sms' | 'email'

/** `pending`: an email opt-in waiting for the emailed link. */
export type SubscriptionState = 'off' | 'on' | 'pending'

const subscriptionRowSchema = z.object({
	topic: z.enum(['marketing', 'product_updates', 'drops', 'reservations']),
	channel: z.enum(['sms', 'email']),
	subscribed: z.boolean(),
	confirmed: z.boolean().optional(),
})

/** `GET /subscriptions`: a missing row means not subscribed. */
const subscriptionsResponseSchema = z.object({
	subscriptions: z.array(subscriptionRowSchema),
})

const updateResponseSchema = z.object({
	pending: z.boolean().optional(),
})

export type SubscriptionRow = z.infer<typeof subscriptionRowSchema>

export function subscriptionState(
	rows: readonly SubscriptionRow[],
	topic: SubscriptionTopic,
	channel: SubscriptionChannel,
): SubscriptionState {
	const row = rows.find((r) => r.topic === topic && r.channel === channel)
	if (!row?.subscribed) return 'off'
	return channel === 'email' && row.confirmed === false ? 'pending' : 'on'
}

/** Why a change was refused, for the screen to word. */
export type SubscriptionFailure =
	'needs_email' | 'needs_phone' | 'network' | 'unknown'

export function subscriptionFailure(
	error: unknown,
	channel: SubscriptionChannel,
): SubscriptionFailure {
	if (error instanceof ApiError) {
		if (error.status === 409) {
			return channel === 'email' ? 'needs_email' : 'needs_phone'
		}
		if (error.isTransportFailure) return 'network'
	}
	return 'unknown'
}

/**
 * The customer's message preferences, `GET /subscriptions` and
 * `PUT /subscriptions/:topic/:channel` on the regional tenant-api, called
 * straight from the app with the customer token (refreshed once on a 401 by
 * the session). Nothing here is proxied through the control plane.
 */
export class SubscriptionsClient {
	readonly #session: CustomerSession

	constructor(session: CustomerSession) {
		this.#session = session
	}

	async list(): Promise<SubscriptionRow[]> {
		const path = '/subscriptions'
		const response = await this.#session.authorized((token) =>
			this.#send('GET', path, token),
		)
		return decodeResponse(response, subscriptionsResponseSchema, path)
			.subscriptions
	}

	/** The state after the change; an email opt-in is `pending` until the link is followed. */
	async set(
		topic: SubscriptionTopic,
		channel: SubscriptionChannel,
		subscribed: boolean,
		/** Id of the wording shown for this switch; omit when none covers it. */
		textVersion?: string,
	): Promise<SubscriptionState> {
		const path = `/subscriptions/${topic}/${channel}`
		const json = {
			subscribed,
			source: 'profile',
			...(subscribed && textVersion ? { textVersion } : {}),
		}
		const response = await this.#session.authorized((token) =>
			this.#send('PUT', path, token, json),
		)
		if (!subscribed) return 'off'
		const answer = decodeResponse(response, updateResponseSchema, path)
		return answer.pending ? 'pending' : 'on'
	}

	#send(method: 'GET' | 'PUT', path: string, token: string, json?: unknown) {
		const client = this.#session.client
		return performRequest(client.transport, {
			method,
			url: buildUrl(client.regionalBaseUrl(), path),
			headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
			json,
			timeoutMs: client.configuration.requestTimeoutMs,
		})
	}
}
