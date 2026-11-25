import crypto from 'node:crypto'
import { Hono } from 'hono'
import * as jose from 'jose'
import { brand } from '@repo/config/brand'
import {
	formatPosDeviceSecret,
	POS_STAFF_SESSION_HEADER,
} from '@repo/common/pos-orders'
import {
	getTenantDb,
	posDevices,
	posManagers,
	restaurantOrders,
	staffJobs,
	staffMembers,
	staffPositions,
	staffScopeAssignments,
} from '@repo/tenant-db'
import { hashPosSecret } from '../src/lib/pos-auth.ts'
import { mintPosStaffSession } from '../src/lib/pos-staff-session.ts'
import { posDeliveriesRoutes } from '../src/routes/pos-deliveries.ts'
import { OPERATOR_SECRET, ORG_A } from './staff-harness.ts'

/**
 * Shared fixture for the own-driver delivery suites (#287, #324): a paired
 * terminal at one location, a roster (two drivers, a manager, a cashier), ready
 * delivery orders, and callers for the Station and operator routes.
 */

export const DELIVERY_LOCATION = 'loc-1'

export const stationApp = new Hono().route('/pos/deliveries', posDeliveriesRoutes)

export type DeliveryWorld = {
	deviceId: string
	secret: string
	positionId: string
	staff: Record<'ana' | 'ben' | 'mona' | 'sam', string>
	sessions: Record<'ana' | 'ben' | 'mona' | 'sam', string>
}

export async function seedDeliveryWorld(orgId = ORG_A): Promise<DeliveryWorld> {
	const db = await getTenantDb(orgId)
	const deviceId = crypto.randomUUID()
	const secret = formatPosDeviceSecret(orgId, deviceId, 'x'.repeat(43))
	await db.insert(posDevices).values({
		id: deviceId,
		label: 'Counter',
		terminalCode: 'C1',
		locationId: DELIVERY_LOCATION,
		signInRequired: true,
		secretHash: hashPosSecret(secret),
		pairedBy: 'operator',
	})
	const [position] = await db
		.insert(staffPositions)
		.values({ name: 'Driver', deliversOrders: true })
		.returning()
	const [counter] = await db
		.insert(staffPositions)
		.values({ name: 'Cashier', deliversOrders: false })
		.returning()
	const add = async (
		first: string,
		last: string,
		options: { driver?: boolean; manager?: boolean; phone?: string } = {},
	) => {
		const id = crypto.randomUUID()
		await db.insert(staffMembers).values({
			id,
			firstName: first,
			lastName: last,
			phone: options.phone ?? null,
		})
		await db
			.insert(staffScopeAssignments)
			.values({ staffId: id, scopeId: DELIVERY_LOCATION, pinLookup: `pin-${id}` })
		await db.insert(staffJobs).values({
			staffId: id,
			scopeId: DELIVERY_LOCATION,
			positionId: options.driver ? position!.id : counter!.id,
			currency: 'USD',
			isPrimary: true,
			effectiveFrom: '2026-01-01',
		})
		if (options.manager) {
			await db.insert(posManagers).values({ staffId: id, addedBy: 'operator' })
		}
		return id
	}
	const staff = {
		ana: await add('Ana', 'Driver', { driver: true, phone: '+15550001111' }),
		ben: await add('Ben', 'Driver', { driver: true, phone: '+15550002222' }),
		mona: await add('Mona', 'Manager', { manager: true }),
		sam: await add('Sam', 'Cashier'),
	}
	const sessions = {} as DeliveryWorld['sessions']
	for (const [name, staffId] of Object.entries(staff)) {
		sessions[name as keyof typeof staff] = (
			await mintPosStaffSession({
				orgId,
				deviceId,
				staffId,
				role: name === 'mona' ? 'manager' : 'cashier',
			})
		).token
	}
	return { deviceId, secret, positionId: position!.id, staff, sessions }
}

let orderSeq = 0

/** A ready delivery order at the location; `cash` makes it pay-at-handoff and unpaid. */
export async function insertDeliveryOrder(
	options: {
		orgId?: string
		number?: string
		status?: 'ready' | 'accepted' | 'completed' | 'cancelled'
		cash?: boolean
		tipCents?: number
		totalCents?: number
		address?: string
		firstName?: string
		zoneId?: string
		promisedAt?: Date
		locationId?: string
		email?: string | null
	} = {},
): Promise<string> {
	orderSeq += 1
	const db = await getTenantDb(options.orgId ?? ORG_A)
	const id = crypto.randomUUID()
	const total = options.totalCents ?? 2500
	await db.insert(restaurantOrders).values({
		id,
		orgId: options.orgId ?? ORG_A,
		number: options.number ?? `D-${orderSeq}`,
		status: options.status ?? 'ready',
		paymentMethod: options.cash ? 'handoff' : 'online',
		paymentStatus: options.cash ? 'unpaid' : 'paid',
		fulfillment: 'delivery',
		locationId: options.locationId ?? DELIVERY_LOCATION,
		locationName: 'Main',
		contactName: `${options.firstName ?? 'Layla'} Guest`,
		contactPhone: '+15551234567',
		contactEmail: options.email === undefined ? 'layla@example.com' : options.email,
		currency: 'USD',
		subtotalCents: total,
		taxCents: 0,
		tipCents: options.tipCents ?? 0,
		totalCents: total,
		deliveryAddress: options.address ?? '233 South Wacker Drive, Chicago',
		deliveryCity: 'Chicago',
		deliveryUnit: 'Suite 4',
		deliveryNotes: 'Front desk',
		deliveryZoneId: options.zoneId ?? 'zone-a',
		promisedAt: options.promisedAt ?? null,
		guestMessages: { receipt: true, ready: true, cancelled: true },
		lines: [],
		idempotencyKey: crypto.randomUUID(),
		requestHash: 'x',
		receiptTokenHash: 'y',
	})
	return id
}

export function stationCall(
	world: DeliveryWorld,
	who: keyof DeliveryWorld['sessions'] | null,
	method: string,
	suffix: string,
	body?: unknown,
	options: { token?: string; session?: string } = {},
) {
	const session = options.session ?? (who ? world.sessions[who] : null)
	return stationApp.request(`/pos/deliveries${suffix}`, {
		method,
		headers: {
			Authorization: `Bearer ${options.token ?? world.secret}`,
			'Content-Type': 'application/json',
			...(session ? { [POS_STAFF_SESSION_HEADER]: session } : {}),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
}

export async function operatorToken(
	claims: Record<string, unknown> = {},
	orgId = ORG_A,
) {
	const now = Math.floor(Date.now() / 1000)
	return new jose.SignJWT({
		role: 'operator',
		orgId,
		scope: 'orders:write',
		deliveries: true,
		locationIds: null,
		...claims,
	})
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject('usr_1')
		.setIssuer(brand.shortName)
		.setAudience('tenant-api-operator')
		.setIssuedAt(now)
		.setExpirationTime(now + 300)
		.sign(new TextEncoder().encode(OPERATOR_SECRET))
}
