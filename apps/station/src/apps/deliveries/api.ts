import {
	type DeliveryBoard,
	type DeliveryProblemKindValue,
	type DriverSelf,
} from '@repo/common/delivery-runs'
import { POS_STAFF_SESSION_HEADER } from '@repo/common/pos-orders'
import { noteServerDate } from '~/lib/clock.ts'
import { type PosSettings } from '~/lib/config.ts'
import { serversProblem } from '~/lib/pairing.ts'
import { type Session } from '~/lib/signin.ts'

export class DeliveriesError extends Error {
	constructor(
		readonly code: string,
		readonly status = 0,
	) {
		super(code)
	}
}

export type DriverNoticeKind = 'assigned' | 'taken_away' | 'stop_released'

export type DeliveriesMe = DriverSelf & {
	notices: Array<{
		id: string
		kind: DriverNoticeKind
		orderNumbers: string[]
		createdAt: number
	}>
}

/** What the Deliveries screen asks of the region (or, in demo mode, of the tab). */
export type DeliveriesApi = {
	me: () => Promise<DeliveriesMe>
	board: () => Promise<DeliveryBoard>
	assign: (driverStaffId: string, orderIds: string[]) => Promise<void>
	claim: (orderIds: string[]) => Promise<void>
	reassign: (runId: string, driverStaffId: string) => Promise<void>
	pickUp: (runId: string) => Promise<void>
	delivered: (stopId: string, cashCollectedCents?: number) => Promise<void>
	problem: (stopId: string, kind: DeliveryProblemKindValue) => Promise<void>
	release: (stopId: string) => Promise<void>
	callGuest: (stopId: string) => Promise<void>
	driverAvailability: (staffId: string, unavailable: boolean) => Promise<void>
	myAvailability: (unavailable: boolean) => Promise<void>
	sharePosition: (lat: number, lng: number) => Promise<void>
	stopSharing: () => Promise<void>
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null

/**
 * The region's `/pos/deliveries` routes, straight from the tablet: guest names
 * and addresses never pass through another server. Nothing is cached
 * (`no-store`, no IndexedDB), nothing is retried and nothing is queued offline:
 * a delivery action needs the live run, so after a failure the screen reads it
 * back. A finished run leaves no address on the device because none is stored.
 */
export function createDeliveriesApi(
	settings: PosSettings,
	session: Session | null,
	fetchImpl = fetch,
): DeliveriesApi {
	async function call<T>(
		method: 'GET' | 'POST' | 'DELETE',
		path: string,
		body?: unknown,
	): Promise<T> {
		if (!settings.deviceToken) throw new DeliveriesError('invalid_device', 401)
		if (!settings.tenantApiUrl || serversProblem([settings.tenantApiUrl])) {
			throw new DeliveriesError('invalid_server', 400)
		}
		const sentAt = Date.now()
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), 8_000)
		try {
			const response = await fetchImpl(
				`${settings.tenantApiUrl.replace(/\/+$/, '')}/pos/deliveries${path}`,
				{
					method,
					cache: 'no-store',
					credentials: 'omit',
					headers: {
						Authorization: `Bearer ${settings.deviceToken}`,
						...(body !== undefined
							? { 'Content-Type': 'application/json' }
							: {}),
						...(session?.serverSession
							? { [POS_STAFF_SESSION_HEADER]: session.serverSession.token }
							: {}),
					},
					...(body !== undefined ? { body: JSON.stringify(body) } : {}),
					signal: controller.signal,
				},
			)
			noteServerDate(response, sentAt)
			const raw: unknown = await response.json().catch(() => null)
			if (!response.ok) {
				throw new DeliveriesError(
					isObject(raw) && typeof raw.error === 'string'
						? raw.error
						: 'deliveries_unavailable',
					response.status,
				)
			}
			if (!isObject(raw)) throw new DeliveriesError('invalid_response', 502)
			return raw as T
		} catch (failure) {
			if (failure instanceof DeliveriesError) throw failure
			throw new DeliveriesError('connection_lost')
		} finally {
			clearTimeout(timeout)
		}
	}
	const one = (id: string) => encodeURIComponent(id)
	const done = async (promise: Promise<unknown>) => {
		await promise
	}
	return {
		me: () => call<DeliveriesMe>('GET', '/me'),
		board: () => call<DeliveryBoard>('GET', '/board'),
		assign: (driverStaffId, orderIds) =>
			done(call('POST', '/runs', { driverStaffId, orderIds })),
		claim: (orderIds) => done(call('POST', '/claim', { orderIds })),
		reassign: (runId, driverStaffId) =>
			done(call('POST', `/runs/${one(runId)}/reassign`, { driverStaffId })),
		pickUp: (runId) => done(call('POST', `/runs/${one(runId)}/pickup`)),
		delivered: (stopId, cashCollectedCents) =>
			done(
				call(
					'POST',
					`/stops/${one(stopId)}/delivered`,
					cashCollectedCents !== undefined ? { cashCollectedCents } : {},
				),
			),
		problem: (stopId, kind) =>
			done(call('POST', `/stops/${one(stopId)}/problem`, { kind })),
		release: (stopId) => done(call('POST', `/stops/${one(stopId)}/release`)),
		callGuest: (stopId) => done(call('POST', `/stops/${one(stopId)}/call`)),
		driverAvailability: (staffId, unavailable) =>
			done(
				call('POST', `/drivers/${one(staffId)}/availability`, { unavailable }),
			),
		myAvailability: (unavailable) =>
			done(call('POST', '/me/availability', { unavailable })),
		sharePosition: (lat, lng) =>
			done(call('POST', '/run/location', { lat, lng })),
		stopSharing: () => done(call('DELETE', '/run/location')),
	}
}
