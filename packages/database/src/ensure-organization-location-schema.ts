import { sql } from 'drizzle-orm'
import { db } from './client.ts'

interface ColumnInfo {
	cid: number
	name: string
	type: string
	notnull: number
	dflt_value: string | null
	pk: number
}

/**
 * Ensures OrganizationLocation table conforms to the current Drizzle schema.
 * Migrates existing data if legacy columns (e.g. `active`, `addressLine1`) are present.
 */
export async function ensureOrganizationLocationSchema() {
	const columns = (await db.all(
		sql`PRAGMA table_info('OrganizationLocation')`,
	)) as unknown as ColumnInfo[]

	if (columns.length === 0) {
		// Table doesn't exist yet, Drizzle migrations will create it
		return
	}

	const colNames = new Set(columns.map((c) => c.name))

	// If table already has `isActive` and no longer has legacy `active`, schema is up to date
	if (colNames.has('isActive') && !colNames.has('active')) {
		// Ensure deliveryConfig has providers and valid time properties
		await db.run(sql`
			UPDATE \`OrganizationLocation\`
			SET \`deliveryConfig\` = json_object(
				'providers', json_array('in_house', 'uber_eats', 'doordash'),
				'estimatedDeliveryTimeMin', 20,
				'estimatedDeliveryTimeMax', 45
			)
			WHERE \`deliveryConfig\` IS NULL OR json_extract(\`deliveryConfig\`, '$.providers') IS NULL;
		`)
		return
	}

	console.log(
		'🔄 Migrating OrganizationLocation from legacy schema to current schema...',
	)

	await db.run(sql`PRAGMA foreign_keys = OFF`)

	await db.run(sql`
		CREATE TABLE IF NOT EXISTS \`OrganizationLocation_new\` (
			\`id\` text PRIMARY KEY NOT NULL,
			\`organizationId\` text NOT NULL,
			\`name\` text NOT NULL,
			\`slug\` text NOT NULL,
			\`phone\` text,
			\`timezone\` text DEFAULT 'America/New_York' NOT NULL,
			\`taxRate\` real DEFAULT 0 NOT NULL,
			\`address\` text,
			\`storeHours\` text,
			\`onlineHours\` text,
			\`specialHours\` text,
			\`prepTime\` integer DEFAULT 15 NOT NULL,
			\`largeOrderThreshold\` real DEFAULT 100,
			\`largeOrderThresholdType\` text DEFAULT 'dollars' NOT NULL,
			\`largeOrderExtraPrepTime\` integer DEFAULT 15 NOT NULL,
			\`fulfillmentOptions\` text,
			\`inHouseTips\` text,
			\`scheduling\` text,
			\`deliveryConfig\` text,
			\`deliveryZones\` text,
			\`isActive\` integer DEFAULT true NOT NULL,
			\`isDefault\` integer DEFAULT false NOT NULL,
			\`createdAt\` integer NOT NULL,
			\`updatedAt\` integer NOT NULL,
			FOREIGN KEY (\`organizationId\`) REFERENCES \`Organization\`(\`id\`) ON UPDATE cascade ON DELETE cascade
		);
	`)

	// Copy data from old table to new table
	await db.run(sql`
		INSERT INTO \`OrganizationLocation_new\` (
			\`id\`,
			\`organizationId\`,
			\`name\`,
			\`slug\`,
			\`phone\`,
			\`timezone\`,
			\`taxRate\`,
			\`address\`,
			\`storeHours\`,
			\`onlineHours\`,
			\`specialHours\`,
			\`prepTime\`,
			\`largeOrderThreshold\`,
			\`largeOrderThresholdType\`,
			\`largeOrderExtraPrepTime\`,
			\`fulfillmentOptions\`,
			\`inHouseTips\`,
			\`scheduling\`,
			\`deliveryConfig\`,
			\`deliveryZones\`,
			\`isActive\`,
			\`isDefault\`,
			\`createdAt\`,
			\`updatedAt\`
		)
		SELECT
			\`id\`,
			\`organizationId\`,
			\`name\`,
			COALESCE(NULLIF(\`slug\`, ''), 'main'),
			\`phone\`,
			COALESCE(\`timezone\`, 'America/New_York'),
			COALESCE(\`taxRate\`, 0),
			CASE
				WHEN \`formattedAddress\` IS NOT NULL OR \`addressLine1\` IS NOT NULL THEN
					json_object(
						'formattedAddress', COALESCE(\`formattedAddress\`, ''),
						'streetNumber', '',
						'route', COALESCE(\`addressLine1\`, ''),
						'locality', COALESCE(\`city\`, ''),
						'administrativeAreaLevel1', COALESCE(\`state\`, ''),
						'postalCode', COALESCE(\`postalCode\`, ''),
						'country', COALESCE(\`country\`, 'US'),
						'lat', \`latitude\`,
						'lng', \`longitude\`
					)
				ELSE NULL
			END,
			COALESCE(\`storeHoursJson\`, \`hoursJson\`),
			COALESCE(\`onlineHoursJson\`, \`storeHoursJson\`, \`hoursJson\`),
			\`specialHoursJson\`,
			COALESCE(\`prepTimeMinutes\`, 15),
			COALESCE(\`largeOrderThreshold\`, 100),
			COALESCE(\`largeOrderThresholdType\`, 'dollars'),
			COALESCE(\`largeOrderExtraMinutes\`, 15),
			json_object(
				'pickup', CASE WHEN \`pickupEnabled\` = 1 THEN json('true') ELSE json('false') END,
				'delivery', CASE WHEN \`deliveryEnabled\` = 1 THEN json('true') ELSE json('false') END,
				'dineIn', CASE WHEN \`dineInEnabled\` = 1 THEN json('true') ELSE json('false') END,
				'curbside', json('false')
			),
			json_object(
				'pickupTips', CASE WHEN \`pickupTipsEnabled\` = 1 THEN json('true') ELSE json('false') END,
				'deliveryTips', CASE WHEN \`deliveryTipsEnabled\` = 1 THEN json('true') ELSE json('false') END,
				'dineInTips', CASE WHEN \`dineInTipsEnabled\` = 1 THEN json('true') ELSE json('false') END
			),
			json_object(
				'scheduledOrdersEnabled', CASE WHEN \`scheduledOrdersEnabled\` = 1 THEN json('true') ELSE json('false') END,
				'advanceOrderDays', COALESCE(\`scheduledAdvanceDaysMax\`, 7)
			),
			json_object(
				'providers', json_array('in_house', 'uber_eats', 'doordash'),
				'estimatedDeliveryTimeMin', 20,
				'estimatedDeliveryTimeMax', COALESCE(\`deliveryTimeMinutes\`, 45)
			),
			'[]',
			COALESCE(\`active\`, 1),
			COALESCE(\`isDefault\`, 1),
			\`createdAt\`,
			\`updatedAt\`
		FROM \`OrganizationLocation\`;
	`)

	await db.run(sql`DROP TABLE \`OrganizationLocation\``)
	await db.run(
		sql`ALTER TABLE \`OrganizationLocation_new\` RENAME TO \`OrganizationLocation\``,
	)
	await db.run(
		sql`CREATE INDEX IF NOT EXISTS \`OrganizationLocation_organizationId_idx\` ON \`OrganizationLocation\` (\`organizationId\`)`,
	)
	await db.run(
		sql`CREATE UNIQUE INDEX IF NOT EXISTS \`OrganizationLocation_organizationId_slug_key\` ON \`OrganizationLocation\` (\`organizationId\`, \`slug\`)`,
	)

	await db.run(sql`PRAGMA foreign_keys = ON`)

	// Normalize any rows where deliveryConfig lacks providers
	await db.run(sql`
		UPDATE \`OrganizationLocation\`
		SET \`deliveryConfig\` = json_object(
			'providers', json_array('in_house', 'uber_eats', 'doordash'),
			'estimatedDeliveryTimeMin', 20,
			'estimatedDeliveryTimeMax', 45
		)
		WHERE \`deliveryConfig\` IS NULL OR json_extract(\`deliveryConfig\`, '$.providers') IS NULL;
	`)

	console.log('✅ OrganizationLocation schema migration complete.')
}
