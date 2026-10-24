import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	rsvGuests,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveOrCreateGuestForBooking } from './rsv-guest-service.ts'

const ORG = 'org_guest_keep_profile'
let tempDir: string

beforeEach(async () => {
	tempDir = mkdtempSync(path.join(tmpdir(), 'rsv-keep-profile-'))
	process.env.TENANT_DB_DIR = tempDir
	process.env.DATA_REGION = 'us'
	await provisionTenantDb(ORG)
})

afterEach(async () => {
	await destroyTenantDb(ORG)
	rmSync(tempDir, { recursive: true, force: true })
})

describe('a booking by someone who cannot see guest details', () => {
	it('links a known number, fills what the profile lacks, and replaces nothing', async () => {
		const db = await getTenantDb(ORG)
		const maya = await resolveOrCreateGuestForBooking(db, {
			guest: {
				firstName: 'Maya',
				lastName: 'Haddad',
				phone: '+14155550111',
				allergyNotes: 'Peanuts',
			},
		})
		const filled = await resolveOrCreateGuestForBooking(db, {
			guest: {
				firstName: 'Mia',
				phone: '+14155550111',
				email: 'maya@example.com',
				allergyNotes: 'None',
			},
			keepMatchedProfile: true,
		})
		expect(filled.id).toBe(maya.id)
		const kept = await resolveOrCreateGuestForBooking(db, {
			guest: {
				firstName: 'Stranger',
				phone: '+14155550111',
				email: 'stranger@example.com',
			},
			keepMatchedProfile: true,
		})
		expect(kept.id).toBe(maya.id)
		const row = await db
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, maya.id))
			.get()
		expect(row?.firstName).toBe('Maya')
		expect(row?.lastName).toBe('Haddad')
		expect(row?.emailNorm).toBe('maya@example.com')
		expect(row?.allergyNotes).toBe('Peanuts')
	})
})
