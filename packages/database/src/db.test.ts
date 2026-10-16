/// <reference types="vitest/globals" />
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { and, eq, getTableName, isNull, like, sql } from 'drizzle-orm'
import { db } from './client.ts'
import { countUsers } from './queries.ts'
import {
	ConfigFlag,
	Permission,
	User,
	_OrganizationPermissionToRole,
} from './schema.ts'

const dbFile = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../db/data.db',
)
const describeDb = fs.existsSync(dbFile) ? describe : describe.skip

test('control-plane table names use PascalCase SQLite identifiers', () => {
	expect(getTableName(User)).toBe('User')
})

describeDb('Drizzle control-plane client', () => {
	test('can query the User table from SQLite', async () => {
		const rows = await db
			.select({
				id: User.id,
				email: User.email,
				username: User.username,
				createdAt: User.createdAt,
			})
			.from(User)
			.limit(5)

		expect(Array.isArray(rows)).toBe(true)

		const countRow = await db.get<{ count: number }>(
			sql`SELECT COUNT(*) as count FROM "User"`,
		)
		expect(countRow?.count).toBeGreaterThanOrEqual(0)
		expect(rows.length).toBeLessThanOrEqual(countRow?.count ?? 0)
		expect(await countUsers()).toBe(countRow?.count ?? 0)

		if (rows[0]) {
			expect(rows[0].id).toEqual(expect.any(String))
			expect(rows[0].email).toEqual(expect.any(String))
			expect(rows[0].createdAt).toBeInstanceOf(Date)

			const byId = await db
				.select({ id: User.id })
				.from(User)
				.where(eq(User.id, rows[0].id))
			expect(byId).toHaveLength(1)
		}
	})

	test('seeds the 8 reservations permissions, org_role_admin grants, and 6 system-level false ConfigFlag rows (VAL-FND-013, VAL-FND-014)', async () => {
		const expectedPermissions = [
			'org_perm_read_reservation_any',
			'org_perm_read_reservation_guest_any',
			'org_perm_read_reservation_report_any',
			'org_perm_read_reservation_settings_any',
			'org_perm_update_reservation_any',
			'org_perm_update_reservation_guest_any',
			'org_perm_update_reservation_payment_any',
			'org_perm_update_reservation_settings_any',
		]

		const perms = await db
			.select({ id: Permission.id })
			.from(Permission)
			.where(like(Permission.id, 'org_perm_%_reservation%'))
		expect(perms.map((p) => p.id).sort()).toEqual(expectedPermissions)

		const adminGrants = await db
			.select({ B: _OrganizationPermissionToRole.B })
			.from(_OrganizationPermissionToRole)
			.where(
				and(
					eq(_OrganizationPermissionToRole.A, 'org_role_admin'),
					like(_OrganizationPermissionToRole.B, 'org_perm_%_reservation%'),
				),
			)
		expect(adminGrants.map((g) => g.B).sort()).toEqual(expectedPermissions)

		const flags = await db
			.select({
				key: ConfigFlag.key,
				value: ConfigFlag.value,
				level: ConfigFlag.level,
				organizationId: ConfigFlag.organizationId,
			})
			.from(ConfigFlag)
			.where(
				and(
					like(ConfigFlag.key, 'reservations.%'),
					eq(ConfigFlag.level, 'system'),
					isNull(ConfigFlag.organizationId),
				),
			)

		expect(flags.map((f) => f.key).sort()).toEqual([
			'reservations.enabled',
			'reservations.experiences',
			'reservations.online',
			'reservations.payments',
			'reservations.voice',
			'reservations.waitlist',
		])
		for (const flag of flags) {
			expect(flag.value).toBe(false)
			expect(flag.level).toBe('system')
			expect(flag.organizationId).toBeNull()
		}
	})
})
