/**
 * Seeds QR ordering for a local demo organization:
 *
 *   npm run seed:qr -w tenant-api -- <org-slug>
 *
 * Turns on `qr_ordering.enabled`, `.dine_in` and `.online` for the
 * organization (LibSQL and, when present, the App's local D1), provisions the
 * regional database, and idempotently creates tables T1..T8 at the default
 * location plus the default QR settings, through the same services as the
 * API. Prints one dine-in URL to try.
 *
 * Local development only: the same guards as `seed:reservations` (explicit
 * NODE_ENV, local databases, demo slugs or `SEED_RESERVATIONS_ALLOW`).
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
	and,
	asc,
	ConfigFlag,
	db,
	desc,
	eq,
	Organization,
	OrganizationLocation,
} from '@repo/database'
import { QR_ORDERING_FLAG_KEY_LIST, qrTableUrl } from '@repo/common/qr-ordering'
import { provisionTenantDb } from '@repo/tenant-db'
import { deriveTableToken } from '../src/lib/qr-tokens.ts'
import {
	createQrTables,
	getQrSettings,
	listQrTables,
	patchQrSettings,
} from '../src/services/qr-tab-service.ts'
import {
	assertLocalSeedEnvironment,
	resolveSeedSlug,
} from './seed-reservations-guard.ts'

const TABLE_LABELS = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']

function sqlLiteral(value: string | number): string {
	if (typeof value === 'number') return String(value)
	return `'${value.replace(/'/g, "''")}'`
}

/** App dev reads flags from local D1, not LibSQL: mirror them there. */
function syncFlagsToLocalD1(slug: string) {
	const d1Dir = path.resolve(
		import.meta.dirname,
		'../../app/.wrangler/state/v3/d1/miniflare-D1DatabaseObject',
	)
	if (!fs.existsSync(d1Dir)) return
	const now = Date.now()
	const statements = QR_ORDERING_FLAG_KEY_LIST.flatMap((key) => [
		`DELETE FROM ConfigFlag WHERE key = ${sqlLiteral(key)} AND level = 'organization' AND organizationId = (SELECT id FROM Organization WHERE slug = ${sqlLiteral(slug)});`,
		`INSERT INTO ConfigFlag (id, key, value, level, organizationId, createdAt, updatedAt) SELECT 'cf_' || id || '_' || ${sqlLiteral(key)}, ${sqlLiteral(key)}, 'true', 'organization', id, ${now}, ${now} FROM Organization WHERE slug = ${sqlLiteral(slug)};`,
	])
	for (const file of fs.readdirSync(d1Dir)) {
		if (!file.endsWith('.sqlite') || file === 'metadata.sqlite') continue
		const result = spawnSync(
			'sqlite3',
			[path.join(d1Dir, file), statements.join('\n')],
			{ encoding: 'utf8' },
		)
		if (result.status !== 0 && result.stderr) {
			console.warn(`D1 sync warning (${file}): ${result.stderr.trim()}`)
		}
	}
}

async function main() {
	assertLocalSeedEnvironment({
		nodeEnv: process.env.NODE_ENV,
		databaseUrl: process.env.DATABASE_URL,
		tenantDbDir: process.env.TENANT_DB_DIR,
	})
	const slug = resolveSeedSlug({
		slug: process.argv.slice(2).find((arg) => !arg.startsWith('--')),
		allow: process.env.SEED_RESERVATIONS_ALLOW,
	})

	const [org] = await db
		.select({ id: Organization.id, name: Organization.name })
		.from(Organization)
		.where(eq(Organization.slug, slug))
		.limit(1)
	if (!org) {
		throw new Error(
			`Organization "${slug}" does not exist locally; run seed:reservations -- ${slug} first.`,
		)
	}
	const [location] = await db
		.select({ id: OrganizationLocation.id, name: OrganizationLocation.name })
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, org.id),
				eq(OrganizationLocation.isActive, true),
			),
		)
		.orderBy(
			desc(OrganizationLocation.isDefault),
			asc(OrganizationLocation.createdAt),
		)
		.limit(1)
	if (!location) throw new Error(`"${slug}" has no active location.`)

	for (const key of QR_ORDERING_FLAG_KEY_LIST) {
		const where = and(
			eq(ConfigFlag.key, key),
			eq(ConfigFlag.level, 'organization'),
			eq(ConfigFlag.organizationId, org.id),
		)
		const [existing] = await db
			.select({ id: ConfigFlag.id, value: ConfigFlag.value })
			.from(ConfigFlag)
			.where(where)
			.limit(1)
		if (!existing) {
			await db.insert(ConfigFlag).values({
				key,
				value: true,
				level: 'organization',
				organizationId: org.id,
			})
		} else if (existing.value !== true) {
			await db
				.update(ConfigFlag)
				.set({ value: true })
				.where(eq(ConfigFlag.id, existing.id))
		}
	}
	syncFlagsToLocalD1(slug)

	await provisionTenantDb(org.id)
	const existing = await listQrTables(org.id, {
		locationId: location.id,
		withTokens: false,
	})
	const missing = TABLE_LABELS.filter(
		(label) => !existing.some((table) => table.label === label),
	)
	if (missing.length > 0) {
		const created = await createQrTables(org.id, {
			locationId: location.id,
			labels: missing,
		})
		if (!created.ok) throw new Error(created.failure.message)
	}
	await patchQrSettings(org.id, await getQrSettings(org.id))

	const tables = await listQrTables(org.id, {
		locationId: location.id,
		withTokens: false,
	})
	const first = tables[0]!
	const origin =
		process.env.SEED_SITE_ORIGIN || `https://${slug}.menuza.test:2999`
	console.info(
		`QR ordering seeded for ${org.name}: ${tables.length} tables at ${location.name}.`,
	)
	console.info(
		`Try table ${first.label}: ${qrTableUrl(origin, location.id, deriveTableToken(org.id, first.id, first.tokenVersion))}`,
	)
}

main().then(
	() => process.exit(0),
	(error) => {
		console.error(error instanceof Error ? error.message : error)
		process.exit(1)
	},
)
