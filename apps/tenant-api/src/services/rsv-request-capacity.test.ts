import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	rsvGuests,
	rsvReservations,
	type TenantDatabase,
} from '@repo/tenant-db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	canHoldRequestCapacity,
	MAX_OPEN_REQUESTS_PER_ADDRESS,
	MAX_OPEN_REQUESTS_PER_LOCATION,
} from './rsv-public-booking-service.ts'

const ORG = 'org_request_capacity'
const LOC = 'loc_a'
let dir: string
let db: TenantDatabase
let n = 0

beforeEach(async () => {
	dir = mkdtempSync(path.join(tmpdir(), 'rsv-req-cap-'))
	process.env.TENANT_DB_DIR = dir
	process.env.DATA_REGION = 'us'
	await provisionTenantDb(ORG)
	db = await getTenantDb(ORG)
	await db.insert(rsvGuests).values({
		id: 'g1',
		firstName: 'A',
		lastName: 'B',
		phoneE164: '+14155550101',
	})
})

afterEach(async () => {
	await destroyTenantDb(ORG)
	rmSync(dir, { recursive: true, force: true })
})

async function openRequest(
	ipHash: string,
	over: Partial<typeof rsvReservations.$inferInsert> = {},
) {
	n += 1
	const startAt = Date.parse('2031-03-10T19:00:00Z') + n * 60_000
	await db.insert(rsvReservations).values({
		id: `r${n}`,
		locationId: LOC,
		guestId: 'g1',
		confirmationCode: `C${n}`,
		businessDate: '2031-03-10',
		localStartMin: 1140,
		timeZone: 'UTC',
		startAt,
		endAt: startAt + 5_400_000,
		durationMin: 90,
		partySize: 12,
		status: 'pending_approval',
		createdByKind: 'guest',
		ipHash,
		...over,
	})
}

describe('open large-party requests and held capacity', () => {
	it('lets an address hold tables until its cap, then only takes the request', async () => {
		expect(
			await canHoldRequestCapacity(db, { locationId: LOC, ipHash: 'ip1' }),
		).toBe(true)
		for (let i = 0; i < MAX_OPEN_REQUESTS_PER_ADDRESS; i++) {
			await openRequest('ip1')
		}
		expect(
			await canHoldRequestCapacity(db, { locationId: LOC, ipHash: 'ip1' }),
		).toBe(false)
		// Another address is unaffected.
		expect(
			await canHoldRequestCapacity(db, { locationId: LOC, ipHash: 'ip2' }),
		).toBe(true)
	})

	it('caps the location as a whole, whatever the addresses', async () => {
		for (let i = 0; i < MAX_OPEN_REQUESTS_PER_LOCATION; i++) {
			await openRequest(`ip_${i}`)
		}
		expect(
			await canHoldRequestCapacity(db, { locationId: LOC, ipHash: 'fresh' }),
		).toBe(false)
		expect(
			await canHoldRequestCapacity(db, {
				locationId: 'loc_b',
				ipHash: 'fresh',
			}),
		).toBe(true)
	})

	it('counts only open guest requests: an answered one frees the slot', async () => {
		for (let i = 0; i < MAX_OPEN_REQUESTS_PER_ADDRESS; i++) {
			await openRequest('ip1', i === 0 ? { status: 'booked' } : {})
		}
		expect(
			await canHoldRequestCapacity(db, { locationId: LOC, ipHash: 'ip1' }),
		).toBe(true)
	})
})
