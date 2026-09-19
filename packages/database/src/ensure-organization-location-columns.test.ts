import { describe, expect, it } from 'vitest'

import { ensureOrganizationLocationColumns } from './ensure-organization-location-columns.ts'
import { db } from './client.ts'
import { sql } from 'drizzle-orm'

describe('ensureOrganizationLocationColumns', () => {
	it('adds comprehensive columns when legacy table exists', async () => {
		await ensureOrganizationLocationColumns()
		const rows = await db.all<{ name: string }>(
			sql`PRAGMA table_info('OrganizationLocation')`,
		)
		const names = new Set(rows.map((row) => row.name))
		expect(names.has('latitude')).toBe(true)
		expect(names.has('deliveryEnabled')).toBe(true)
		expect(names.has('specialHoursJson')).toBe(true)
	})
})
