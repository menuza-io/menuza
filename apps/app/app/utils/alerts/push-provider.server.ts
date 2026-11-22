/**
 * The operator push provider, behind one small interface (#106). Expo's push
 * service first (it fronts APNs and FCM); direct APNs and FCM can implement the
 * same interface later. This is NOT the guest customer-app provider
 * (tenant-api, #105) and never touches a guest token: an operator device is a
 * member's phone, kept in the control plane.
 *
 * `MockOperatorPushProvider` is the in-memory emulator for `MOCKS=true` and the
 * tests: nothing here calls Expo, Apple or Google in tests.
 */

export type OperatorPushMessage = {
	/** The device's Expo token. */
	token: string
	title: string
	body: string
	/** The only keys a payload carries: a kind, a link and the notification id. */
	data: { kind: string; url: string | null; notificationId: string }
	/** Our own id, echoed back with the ticket. */
	messageId: string
}

export type OperatorPushTicket =
	| { messageId: string; status: 'ok'; ticketId: string }
	/** The service says this token is no good: the device is deleted. */
	| { messageId: string; status: 'invalid_token' }
	| { messageId: string; status: 'error'; code: string }

export type OperatorPushReceipt = {
	ticketId: string
	status: 'delivered' | 'invalid_token' | 'error'
}

export interface OperatorPushProvider {
	readonly name: string
	send(messages: OperatorPushMessage[]): Promise<OperatorPushTicket[]>
	receipts(ticketIds: string[]): Promise<OperatorPushReceipt[]>
}

const EXPO_SEND = 'https://exp.host/--/api/v2/push/send'
const EXPO_RECEIPTS = 'https://exp.host/--/api/v2/push/getReceipts'
const EXPO_BATCH = 100
const TIMEOUT_MS = 8_000

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export class ExpoOperatorPushProvider implements OperatorPushProvider {
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

	async send(messages: OperatorPushMessage[]): Promise<OperatorPushTicket[]> {
		const fetchImpl = this.options.fetchImpl ?? fetch
		const out: OperatorPushTicket[] = []
		for (let start = 0; start < messages.length; start += EXPO_BATCH) {
			const batch = messages.slice(start, start + EXPO_BATCH)
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
						batch.map((message) => ({
							to: message.token,
							title: message.title,
							body: message.body,
							data: message.data,
							sound: 'default',
							priority: 'high',
						})),
					),
					redirect: 'manual',
					signal: AbortSignal.timeout(TIMEOUT_MS),
				})
				if (!response.ok) throw new Error(`expo_${response.status}`)
				tickets =
					((await response.json()) as { data?: typeof tickets }).data ?? []
			} catch {
				for (const message of batch) {
					out.push({
						messageId: message.messageId,
						status: 'error',
						code: 'provider_unreachable',
					})
				}
				continue
			}
			batch.forEach((message, index) => {
				const ticket = tickets[index]
				if (ticket?.status === 'ok' && ticket.id) {
					out.push({
						messageId: message.messageId,
						status: 'ok',
						ticketId: ticket.id,
					})
				} else if (ticket?.details?.error === 'DeviceNotRegistered') {
					out.push({ messageId: message.messageId, status: 'invalid_token' })
				} else {
					out.push({
						messageId: message.messageId,
						status: 'error',
						code: 'provider_error',
					})
				}
			})
		}
		return out
	}

	async receipts(ticketIds: string[]): Promise<OperatorPushReceipt[]> {
		const fetchImpl = this.options.fetchImpl ?? fetch
		const out: OperatorPushReceipt[] = []
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
				// Receipts are asked for again on the next sweep.
			}
		}
		return out
	}
}

/** In-memory emulator: records what was sent; tests script tickets and receipts. */
export class MockOperatorPushProvider implements OperatorPushProvider {
	readonly name = 'mock'
	readonly sent: OperatorPushMessage[] = []
	/** Tokens the "service" refuses as invalid. */
	readonly invalidTokens = new Set<string>()
	/** Tokens whose send fails with a provider error. */
	readonly failingTokens = new Set<string>()
	/** Receipt outcome per ticket id; unset means delivered. */
	readonly receiptStatus = new Map<string, OperatorPushReceipt['status']>()
	private counter = 0

	async send(messages: OperatorPushMessage[]): Promise<OperatorPushTicket[]> {
		return messages.map((message) => {
			if (this.invalidTokens.has(message.token)) {
				return {
					messageId: message.messageId,
					status: 'invalid_token' as const,
				}
			}
			if (this.failingTokens.has(message.token)) {
				return {
					messageId: message.messageId,
					status: 'error' as const,
					code: 'provider_error',
				}
			}
			this.sent.push(message)
			this.counter += 1
			return {
				messageId: message.messageId,
				status: 'ok' as const,
				ticketId: `mock-ticket-${this.counter}`,
			}
		})
	}

	async receipts(ticketIds: string[]): Promise<OperatorPushReceipt[]> {
		return ticketIds.map((ticketId) => ({
			ticketId,
			status: this.receiptStatus.get(ticketId) ?? 'delivered',
		}))
	}

	reset() {
		this.sent.length = 0
		this.invalidTokens.clear()
		this.failingTokens.clear()
		this.receiptStatus.clear()
		this.counter = 0
	}
}

let override: OperatorPushProvider | null = null
let mock: MockOperatorPushProvider | null = null
let expo: ExpoOperatorPushProvider | null = null

/** Tests inject a provider; `null` restores the default choice. */
export function setOperatorPushProvider(provider: OperatorPushProvider | null) {
	override = provider
}

export function getMockOperatorPushProvider(): MockOperatorPushProvider {
	mock ??= new MockOperatorPushProvider()
	return mock
}

function readEnv(name: string): string {
	const raw = typeof process !== 'undefined' ? process.env?.[name] : undefined
	return typeof raw === 'string' ? raw.trim() : ''
}

/** Injected, else the emulator when `MOCKS=true` or `OPERATOR_PUSH_PROVIDER=mock`, else Expo. */
export function getOperatorPushProvider(): OperatorPushProvider {
	if (override) return override
	if (
		readEnv('OPERATOR_PUSH_PROVIDER') === 'mock' ||
		readEnv('MOCKS').toLowerCase() === 'true'
	) {
		return getMockOperatorPushProvider()
	}
	expo ??= new ExpoOperatorPushProvider({
		accessToken: readEnv('EXPO_ACCESS_TOKEN') || undefined,
	})
	return expo
}
