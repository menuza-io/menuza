import { ENV } from 'varlock/env'
import { type PushPayload } from '@repo/common/push'
import { syncEnvFromProcess } from '../lib/secrets.ts'

/**
 * The push provider, behind one small interface (#105). Expo's push service
 * first (it fronts APNs and FCM and needs no per-app credential from us when
 * the app's EAS project holds them); direct APNs and FCM can implement the
 * same interface later using the credentials the App registry stores.
 *
 * `MockPushProvider` is the in-memory emulator for `MOCKS=true` and the tests:
 * nothing here is called against Expo, Apple or Google in tests.
 */

export type PushDelivery = {
	/** The sealed-out token to send to. */
	token: string
	payload: PushPayload
	/** Our own id, echoed back in the receipt. */
	messageId: string
}

export type PushTicket =
	| { messageId: string; status: 'ok'; ticketId: string }
	/** The service says this token is no good: the device is deleted. */
	| { messageId: string; status: 'invalid_token' }
	| { messageId: string; status: 'error'; code: string }

export type PushReceipt = {
	ticketId: string
	status: 'delivered' | 'invalid_token' | 'error'
}

export interface PushProvider {
	readonly name: string
	send(deliveries: PushDelivery[]): Promise<PushTicket[]>
	receipts(ticketIds: string[]): Promise<PushReceipt[]>
}

const EXPO_SEND = 'https://exp.host/--/api/v2/push/send'
const EXPO_RECEIPTS = 'https://exp.host/--/api/v2/push/getReceipts'
const EXPO_BATCH = 100
const TIMEOUT_MS = 8_000

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export class ExpoPushProvider implements PushProvider {
	readonly name = 'expo'

	constructor(
		private readonly options: {
			accessToken?: string
			fetchImpl?: FetchLike
		} = {},
	) {}

	private headers() {
		return {
			'Content-Type': 'application/json',
			Accept: 'application/json',
			...(this.options.accessToken
				? { Authorization: `Bearer ${this.options.accessToken}` }
				: {}),
		}
	}

	async send(deliveries: PushDelivery[]): Promise<PushTicket[]> {
		const fetchImpl = this.options.fetchImpl ?? fetch
		const out: PushTicket[] = []
		for (let start = 0; start < deliveries.length; start += EXPO_BATCH) {
			const batch = deliveries.slice(start, start + EXPO_BATCH)
			let tickets: Array<{
				status?: string
				id?: string
				details?: { error?: string }
			}> = []
			try {
				const response = await fetchImpl(EXPO_SEND, {
					method: 'POST',
					headers: this.headers(),
					body: JSON.stringify(
						batch.map((delivery) => ({
							to: delivery.token,
							title: delivery.payload.title,
							body: delivery.payload.body,
							// The data object is exactly the allow-listed one: a link, a kind, an id.
							data: delivery.payload.data,
							sound: 'default',
							...(delivery.payload.imageUrl
								? { richContent: { image: delivery.payload.imageUrl } }
								: {}),
						})),
					),
					redirect: 'manual',
					signal: AbortSignal.timeout(TIMEOUT_MS),
				})
				if (!response.ok) throw new Error(`expo_${response.status}`)
				tickets =
					((await response.json()) as { data?: typeof tickets }).data ?? []
			} catch {
				for (const delivery of batch) {
					out.push({
						messageId: delivery.messageId,
						status: 'error',
						code: 'provider_unreachable',
					})
				}
				continue
			}
			batch.forEach((delivery, index) => {
				const ticket = tickets[index]
				if (ticket?.status === 'ok' && ticket.id) {
					out.push({
						messageId: delivery.messageId,
						status: 'ok',
						ticketId: ticket.id,
					})
				} else if (ticket?.details?.error === 'DeviceNotRegistered') {
					out.push({ messageId: delivery.messageId, status: 'invalid_token' })
				} else {
					out.push({
						messageId: delivery.messageId,
						status: 'error',
						code: 'provider_error',
					})
				}
			})
		}
		return out
	}

	async receipts(ticketIds: string[]): Promise<PushReceipt[]> {
		const fetchImpl = this.options.fetchImpl ?? fetch
		const out: PushReceipt[] = []
		for (let start = 0; start < ticketIds.length; start += 1000) {
			const ids = ticketIds.slice(start, start + 1000)
			try {
				const response = await fetchImpl(EXPO_RECEIPTS, {
					method: 'POST',
					headers: this.headers(),
					body: JSON.stringify({ ids }),
					redirect: 'manual',
					signal: AbortSignal.timeout(TIMEOUT_MS),
				})
				if (!response.ok) continue
				const data =
					(
						(await response.json()) as {
							data?: Record<
								string,
								{ status?: string; details?: { error?: string } }
							>
						}
					).data ?? {}
				for (const [ticketId, receipt] of Object.entries(data)) {
					out.push({
						ticketId,
						status:
							receipt.status === 'ok'
								? 'delivered'
								: receipt.details?.error === 'DeviceNotRegistered'
									? 'invalid_token'
									: 'error',
					})
				}
			} catch {
				// Receipts are asked for again on the next tick.
			}
		}
		return out
	}
}

/** In-memory emulator: records what was sent; tests script tickets and receipts. */
export class MockPushProvider implements PushProvider {
	readonly name = 'mock'
	readonly sent: PushDelivery[] = []
	/** Tokens the "service" refuses as invalid. */
	readonly invalidTokens = new Set<string>()
	/** Tokens whose send fails with a provider error. */
	readonly failingTokens = new Set<string>()
	/** Receipt outcome per ticket id; unset means delivered. */
	readonly receiptStatus = new Map<string, PushReceipt['status']>()
	private counter = 0

	async send(deliveries: PushDelivery[]): Promise<PushTicket[]> {
		return deliveries.map((delivery) => {
			if (this.invalidTokens.has(delivery.token)) {
				return {
					messageId: delivery.messageId,
					status: 'invalid_token' as const,
				}
			}
			if (this.failingTokens.has(delivery.token)) {
				return {
					messageId: delivery.messageId,
					status: 'error' as const,
					code: 'provider_error',
				}
			}
			this.sent.push(delivery)
			this.counter += 1
			return {
				messageId: delivery.messageId,
				status: 'ok' as const,
				ticketId: `mock-ticket-${this.counter}`,
			}
		})
	}

	async receipts(ticketIds: string[]): Promise<PushReceipt[]> {
		return ticketIds.map((ticketId) => ({
			ticketId,
			status: this.receiptStatus.get(ticketId) ?? 'delivered',
		}))
	}
}

let override: PushProvider | null = null
let mock: MockPushProvider | null = null
let expo: ExpoPushProvider | null = null

/** Tests inject a provider; `null` restores the default choice. */
export function setPushProvider(provider: PushProvider | null) {
	override = provider
}

export function getMockPushProvider(): MockPushProvider {
	mock ??= new MockPushProvider()
	return mock
}

function readEnv(name: string): string {
	syncEnvFromProcess()
	const raw: unknown =
		typeof process !== 'undefined' && process.env
			? process.env[name]
			: (ENV as Record<string, unknown>)[name]
	return typeof raw === 'string' ? raw.trim() : ''
}

/** Injected, else the emulator when `MOCKS=true` or `PUSH_PROVIDER=mock`, else Expo. */
export function getPushProvider(): PushProvider {
	if (override) return override
	if (
		readEnv('PUSH_PROVIDER') === 'mock' ||
		readEnv('MOCKS').toLowerCase() === 'true'
	) {
		return getMockPushProvider()
	}
	expo ??= new ExpoPushProvider({
		accessToken: readEnv('EXPO_ACCESS_TOKEN') || undefined,
	})
	return expo
}
