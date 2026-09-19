import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const migrationSql = readFileSync(
	join(
		dirname(fileURLToPath(import.meta.url)),
		'../drizzle/0015_organization_locations.sql',
	),
	'utf8',
)

describe('0015_organization_locations migration', () => {
	it('indexes OrganizationLocation idempotently (table via ensure before migrate)', () => {
		expect(migrationSql).not.toContain('CREATE TABLE `OrganizationLocation`')
		expect(migrationSql).toContain(
			'CREATE INDEX IF NOT EXISTS `OrganizationLocation_organizationId_idx`',
		)
	})

	it('adds brand default hours columns on Organization', () => {
		expect(migrationSql).toContain('brandStoreHoursJson')
		expect(migrationSql).toContain('brandOnlineHoursJson')
	})
})
