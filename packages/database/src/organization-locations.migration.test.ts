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
	it('creates OrganizationLocation with default flags', () => {
		expect(migrationSql).toContain('CREATE TABLE `OrganizationLocation`')
		expect(migrationSql).toContain('`isDefault`')
		expect(migrationSql).toContain('REFERENCES `Organization`')
	})
})
