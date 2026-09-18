import { sql } from 'drizzle-orm'
import { db } from './client.ts'

type ColumnDef = {
	name: string
	ddl: string
}

/**
 * Idempotent widen for OrganizationLocation. Migration 0015 uses
 * CREATE TABLE IF NOT EXISTS, so dev DBs that already had the minimal PR #9
 * table never received the new columns — Drizzle then selects missing fields.
 */
const COLUMNS: ColumnDef[] = [
	{
		name: 'formattedAddress',
		ddl: 'ALTER TABLE `OrganizationLocation` ADD COLUMN `formattedAddress` text',
	},
	{
		name: 'latitude',
		ddl: 'ALTER TABLE `OrganizationLocation` ADD COLUMN `latitude` real',
	},
	{
		name: 'longitude',
		ddl: 'ALTER TABLE `OrganizationLocation` ADD COLUMN `longitude` real',
	},
	{
		name: 'googlePlaceId',
		ddl: 'ALTER TABLE `OrganizationLocation` ADD COLUMN `googlePlaceId` text',
	},
	{
		name: 'phone',
		ddl: 'ALTER TABLE `OrganizationLocation` ADD COLUMN `phone` text',
	},
	{
		name: 'email',
		ddl: 'ALTER TABLE `OrganizationLocation` ADD COLUMN `email` text',
	},
	{
		name: 'storeHoursJson',
		ddl: 'ALTER TABLE `OrganizationLocation` ADD COLUMN `storeHoursJson` text',
	},
	{
		name: 'onlineHoursJson',
		ddl: 'ALTER TABLE `OrganizationLocation` ADD COLUMN `onlineHoursJson` text',
	},
	{
		name: 'specialHoursJson',
		ddl: 'ALTER TABLE `OrganizationLocation` ADD COLUMN `specialHoursJson` text',
	},
	{
		name: 'storeHoursOverride',
		ddl: 'ALTER TABLE `OrganizationLocation` ADD COLUMN `storeHoursOverride` integer DEFAULT 0 NOT NULL',
	},
	{
		name: 'onlineHoursOverride',
		ddl: 'ALTER TABLE `OrganizationLocation` ADD COLUMN `onlineHoursOverride` integer DEFAULT 0 NOT NULL',
	},
	{
		name: 'prepTimeMinutes',
		ddl: 'ALTER TABLE `OrganizationLocation` ADD COLUMN `prepTimeMinutes` integer DEFAULT 15 NOT NULL',
	},
	{
		name: 'busyDelayMinutes',
		ddl: 'ALTER TABLE `OrganizationLocation` ADD COLUMN `busyDelayMinutes` integer DEFAULT 0 NOT NULL',
	},
	{
		name: 'acceptWindowSeconds',
		ddl: 'ALTER TABLE `OrganizationLocation` ADD COLUMN `acceptWindowSeconds` integer DEFAULT 0 NOT NULL',
	},
	{
		name: 'pickupEnabled',
		ddl: 'ALTER TABLE `OrganizationLocation` ADD COLUMN `pickupEnabled` integer DEFAULT 1 NOT NULL',
	},
	{
		name: 'deliveryEnabled',
		ddl: 'ALTER TABLE `OrganizationLocation` ADD COLUMN `deliveryEnabled` integer DEFAULT 1 NOT NULL',
	},
	{
		name: 'scheduledOrdersEnabled',
		ddl: 'ALTER TABLE `OrganizationLocation` ADD COLUMN `scheduledOrdersEnabled` integer DEFAULT 1 NOT NULL',
	},
]

async function tableExists(): Promise<boolean> {
	const result = await db.all<{ name: string }>(
		sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'OrganizationLocation'`,
	)
	return result.length > 0
}

async function existingColumns(): Promise<Set<string>> {
	const rows = await db.all<{ name: string }>(
		sql`PRAGMA table_info('OrganizationLocation')`,
	)
	return new Set(rows.map((row) => row.name))
}

export async function ensureOrganizationLocationColumns() {
	if (!(await tableExists())) return

	const present = await existingColumns()
	for (const column of COLUMNS) {
		if (present.has(column.name)) continue
		await db.run(sql.raw(column.ddl))
	}
}
