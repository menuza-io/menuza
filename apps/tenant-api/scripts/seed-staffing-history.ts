/**
 * Seeds the history a demo workplace needs to look lived in, in one
 * organization's regional tenant database (never in the control plane):
 *
 *   npm run seed:staffing-history -w tenant-api -- <org-slug> [--enable]
 *
 * - closed time cards for the last two full weeks (five 8-hour days a person,
 *   an unpaid meal break each), with one person on a 57-paid-hour overtime week,
 *   the older week approved and the latest left for review,
 * - a new-hire onboarding checklist for three people, one partly done.
 *
 * Behind the feature flags: it refuses unless every `staffing.*` flag is on for
 * the organization (`--enable` turns them on). Run `npm run seed:staff` and
 * `npm run seed:timeclock` first (or use `npm run seed:staffing`). It is
 * idempotent: when closed cards already exist it adds none, and a person who
 * already has an onboarding checklist is left alone. It goes through the same
 * service functions as the API, so every row passes the production validation
 * and writes its audit record. Local development only.
 */
import { and, ConfigFlag, db, eq, Organization } from '@repo/database'
import {
	STAFFING_FLAG_KEYS,
	STAFFING_PERMISSION_LIST,
	type StaffingFeature,
} from '@repo/staffing'
import { getTenantDb } from '@repo/tenant-db'
import { primeScopeFacts } from '../src/lib/scope-context.ts'
import { loadSeedScope } from './seed-scope.ts'
import { scopeToScopes, type StaffAuth } from '../src/lib/staff-auth.ts'
import { seedStaffingHistory } from '../src/services/staffing-history-demo.ts'

function fail(message: string): never {
	console.error(message)
	process.exit(1)
}

const FEATURES: readonly StaffingFeature[] = [
	'enabled',
	'timeclock',
	'scheduling',
	'labor',
	'hiring',
]

async function ensureFlag(
	organizationId: string,
	feature: StaffingFeature,
	enable: boolean,
	slug: string,
) {
	const where = and(
		eq(ConfigFlag.key, STAFFING_FLAG_KEYS[feature]),
		eq(ConfigFlag.level, 'organization'),
		eq(ConfigFlag.organizationId, organizationId),
	)
	const [flag] = await db.select().from(ConfigFlag).where(where).limit(1)
	if (flag?.value === true) return
	if (!enable) {
		fail(
			`${STAFFING_FLAG_KEYS[feature]} is off for "${slug}". ` +
				'Run again with --enable to turn it on for this organization.',
		)
	}
	if (flag) await db.update(ConfigFlag).set({ value: true }).where(where)
	else {
		await db.insert(ConfigFlag).values({
			key: STAFFING_FLAG_KEYS[feature],
			value: true,
			level: 'organization',
			organizationId,
		})
	}
	console.info(`Turned on ${STAFFING_FLAG_KEYS[feature]} for "${slug}".`)
}

async function main() {
	if (process.env.NODE_ENV === 'production') {
		fail(
			'seed-staffing-history is for local development and refuses to run in production.',
		)
	}
	const args = process.argv.slice(2)
	const slug = args.find((arg) => !arg.startsWith('--'))
	const enable = args.includes('--enable')
	if (!slug) fail('Usage: seed-staffing-history <org-slug> [--enable]')

	const [org] = await db
		.select({ id: Organization.id })
		.from(Organization)
		.where(eq(Organization.slug, slug))
		.limit(1)
	if (!org) fail(`No organization with slug "${slug}".`)
	for (const feature of FEATURES) {
		await ensureFlag(org.id, feature, enable, slug)
	}

	const scope = await loadSeedScope(org.id)
	// The seed reads the control plane itself, so the scope facts the
	// services would ask the App for are already known here.
	primeScopeFacts(org.id, [
		{
			id: scope.id,
			name: scope.name,
			timeZone: scope.timeZone,
		},
	])

	const tenantDb = await getTenantDb(org.id)
	const auth: StaffAuth = {
		orgId: org.id,
		userId: 'seed-script',
		scope: 'staff',
		grants: STAFFING_PERMISSION_LIST,
		scopeIds: null,
		impersonated: false,
	}
	const result = await seedStaffingHistory(
		{
			db: tenantDb,
			auth,
			scope: scopeToScopes(auth),
			ipHash: null,
			now: Date.now(),
		},
		{ scopeId: scope.id, timeZone: scope.timeZone },
	)
	if (!result.cardsSkipped && result.cards === 0) {
		console.info(`"${slug}" has no staff yet. Run seed:staff first.`)
	} else if (result.cards > 0 && result.approved === 0) {
		console.info(
			'No cards were approved: run seed:timeclock first so the labor policy asks for approval.',
		)
	}
	console.info(
		result.cardsSkipped
			? 'Closed time cards already exist. Not adding any.'
			: `Added ${result.cards} closed time cards over two weeks (${result.approved} approved, one overtime week).`,
	)
	console.info(
		result.checklistsSkipped
			? 'Onboarding checklists already exist. Not adding any.'
			: `Started onboarding checklists for ${result.checklists} people.`,
	)
}

main()
	.then(() => process.exit(0))
	.catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : 'Seeding failed.')
		process.exit(1)
	})
