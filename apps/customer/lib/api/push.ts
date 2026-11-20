import { z } from 'zod'
import { type CustomerSession } from '../session/customer-session'
import { ApiError } from './api-error'
import { buildUrl, decodeResponse, performRequest } from './request'

/** What a guest chose to hear about (#105). Receipts and booking mails are never switched here. */
export type PushPreferences = {
	orders: boolean
	bookings: boolean
	rewards: boolean
	/** Offers and news: marketing, its own opt-in. */
	marketing: boolean
	/** At least one device of this guest is registered for push. */
	hasDevice: boolean
	/** Whether offers and news can be offered at all (`marketing.push`). */
	marketingAvailable: boolean
}

const preferencesSchema = z.object({
	orders: z.boolean(),
	bookings: z.boolean(),
	rewards: z.boolean(),
	marketing: z.boolean(),
	hasDevice: z.boolean(),
	marketingAvailable: z.boolean().catch(false),
})

const registerSchema = z.object({ id: z.string().min(1) })

export type PushPreferencesChange = Partial<
	Pick<PushPreferences, 'orders' | 'bookings' | 'rewards' | 'marketing'>
> & {
	/** Where the marketing opt-in came from. */
	source?: 'profile' | 'app_prompt'
}

/**
 * Push on the regional tenant-api (`/push/*`), straight from the app with the
 * customer token (refreshed once on a 401 by the session). A push token is a
 * device address, never sent anywhere else, and no personal data goes back in
 * any answer here.
 */
export class PushClient {
	readonly #session: CustomerSession

	constructor(session: CustomerSession) {
		this.#session = session
	}

	/**
	 * The guest's switches, or `null` when push is not on for this restaurant
	 * (flag off, kill switch, or the app's push credentials are not set up): the
	 * screen then shows nothing.
	 */
	async preferences(): Promise<PushPreferences | null> {
		const path = '/push/preferences'
		try {
			const response = await this.#session.authorized((token) =>
				this.#send('GET', path, token),
			)
			return decodeResponse(response, preferencesSchema, path)
		} catch (error) {
			if (error instanceof ApiError && error.status === 409) return null
			throw error
		}
	}

	async setPreferences(
		change: PushPreferencesChange,
	): Promise<PushPreferences> {
		const path = '/push/preferences'
		const response = await this.#session.authorized((token) =>
			this.#send('PUT', path, token, change),
		)
		return decodeResponse(response, preferencesSchema, path)
	}

	/** Registers (or refreshes) this device; the answer is its id, kept to delete it on sign-out. */
	async register(input: {
		token: string
		platform: 'ios' | 'android'
		locale: string
	}): Promise<string> {
		const path = '/push/devices'
		const response = await this.#session.authorized((token) =>
			this.#send('POST', path, token, input),
		)
		return decodeResponse(response, registerSchema, path).id
	}

	/** Deletes a device. A device that is already gone is fine. */
	async remove(deviceId: string): Promise<void> {
		const path = `/push/devices/${encodeURIComponent(deviceId)}`
		try {
			await this.#session.authorized((token) =>
				this.#send('DELETE', path, token),
			)
		} catch (error) {
			if (error instanceof ApiError && error.status === 404) return
			throw error
		}
	}

	/** Tells the region a push was opened (counts the tap; only the message id is sent). */
	async opened(messageId: string): Promise<void> {
		const path = '/push/opened'
		try {
			await this.#session.authorized((token) =>
				this.#send('POST', path, token, { messageId }),
			)
		} catch {
			// A counter must never get in the way of opening the screen.
		}
	}

	#send(
		method: 'GET' | 'POST' | 'PUT' | 'DELETE',
		path: string,
		token: string,
		json?: unknown,
	) {
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
