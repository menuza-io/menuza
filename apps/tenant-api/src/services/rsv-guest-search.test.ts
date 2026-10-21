import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	rsvGuests,
	type TenantDatabase,
} from '@repo/tenant-db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { searchGuests } from './rsv-guest-service.ts'

const ORG = 'org_guest_search'
let dir: string
let db: TenantDatabase

beforeEach(async () => {
	dir = mkdtempSync(path.join(tmpdir(), 'rsv-guest-search-'))
	process.env.TENANT_DB_DIR = dir
	process.env.DATA_REGION = 'us'
	await provisionTenantDb(ORG)
	db = await getTenantDb(ORG)
	await db.insert(rsvGuests).values([
		{
			id: 'g1',
			firstName: 'Ana',
			lastName: 'Lopez',
			phoneE164: '+14155550101',
			emailNorm: 'ana@example.com',
		},
		{
			id: 'g2',
			firstName: '50%_off',
			lastName: 'Fan',
			phoneE164: '+14155550102',
			emailNorm: 'fan@example.com',
		},
	])
})

afterEach(async () => {
	await destroyTenantDb(ORG)
	rmSync(dir, { recursive: true, force: true })
})

const ids = async (q: string) =>
	(await searchGuests(db, q)).map((guest) => guest.id).sort()

describe('searchGuests', () => {
	it('finds by name, email and phone digits, case-insensitively', async () => {
		expect(await ids('ana')).toEqual(['g1'])
		expect(await ids('LOPEZ')).toEqual(['g1'])
		expect(await ids('fan@example')).toEqual(['g2'])
		expect(await ids('0102')).toEqual(['g2'])
	})

	it('treats % and _ as literal characters, never wildcards', async () => {
		expect(await ids('%%')).toEqual([])
		expect(await ids('%')).toEqual(['g2'])
		expect(await ids('_')).toEqual(['g2'])
		expect(await ids('a_a')).toEqual([])
		expect(await ids('50%_off')).toEqual(['g2'])
	})
})
