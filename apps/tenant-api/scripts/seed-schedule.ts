/**
 * Seeds a demo schedule for local development, in one organization's regional
 * tenant database (never in the control plane):
 *
 *   npm run seed:schedule -w tenant-api -- <org-slug> [--enable]
 *
 * - this week published (people, two open shifts, a split of positions), with
 *   one pending edit on it,
 * - next week copied as drafts,
 * - one approved and one waiting time-off request, and weekly availability.
 *
 * Behind the feature flags: it refuses unless `staffing.enabled` and
 * `staffing.scheduling` are on for the organization (`--enable` turns them on).
 * With `--links` it also prints a local "my schedule" link (path and fragment
 * only; open it on the app host) for up to three active staff, for trying the
 * public page. Run `npm run seed:staff` first for the roster. It is idempotent: a scope
 * that already has shifts is left alone. It goes through the same service
 * functions as the API, so every row passes the production validation and
 * writes its audit record.
 */
import { and, ConfigFlag, db, eq, Organization } from '@repo/database'
import {
	STAFFING_FLAG_KEYS,
	STAFFING_PERMISSION_LIST,
	type StaffingFeature,
} from '@repo/staffing'
import { SCHEDULE_LINK_PAGE_PATH, scheduleLinkFragment } from '@repo/staffing'
import { getTenantDb, staffMembers } from '@repo/tenant-db'
import { primeScopeFacts } from '../src/lib/scope-context.ts'
import { loadSeedScope } from './seed-scope.ts'
import { scopeToScopes, type StaffAuth } from '../src/lib/staff-auth.ts'
import { ensureScheduleLink } from '../src/services/schedule-link-service.ts'
import { seedDemoSchedule } from '../src/services/schedule-demo.ts'

function fail(message: string): never {
	console.error(message)
	process.exit(1)
}

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

/** Dev only: the links a schedule email would carry, without the host. */
async function printLinks(orgId: string, dataRegion: string | null) {
	const tenant = await getTenantDb(orgId)
	const people = await tenant
		.select({ id: staffMembers.id, firstName: staffMembers.firstName })
		.from(staffMembers)
		.where(eq(staffMembers.status, 'active'))
		.limit(3)
	const region = dataRegion === 'ksa' ? 'ksa' : 'us'
	for (const person of people) {
		const { token } = await ensureScheduleLink(
			tenant,
			orgId,
			person.id,
			Date.now(),
		)
		console.info(
			`${person.firstName}: ${SCHEDULE_LINK_PAGE_PATH}${scheduleLinkFragment(region, token)}`,
		)
	}
}

async function main() {
	if (process.env.NODE_ENV === 'production') {
		fail(
			'seed-schedule is for local development and refuses to run in production.',
		)
	}
	const args = process.argv.slice(2)
	const slug = args.find((arg) => !arg.startsWith('--'))
	const enable = args.includes('--enable')
	const withLinks = args.includes('--links')
	if (!slug) fail('Usage: seed-schedule <org-slug> [--enable] [--links]')

	const [org] = await db
		.select({ id: Organization.id, dataRegion: Organization.dataRegion })
		.from(Organization)
		.where(eq(Organization.slug, slug))
		.limit(1)
	if (!org) fail(`No organization with slug "${slug}".`)
	await ensureFlag(org.id, 'enabled', enable, slug)
	await ensureFlag(org.id, 'scheduling', enable, slug)

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

	const auth: StaffAuth = {
		orgId: org.id,
		userId: 'seed-script',
		scope: 'schedule',
		grants: STAFFING_PERMISSION_LIST,
		scopeIds: null,
		impersonated: false,
	}
	const result = await seedDemoSchedule(
		{
			db: await getTenantDb(org.id),
			auth,
			scope: scopeToScopes(auth),
			ipHash: null,
			now: Date.now(),
		},
		{ scopeId: scope.id, timeZone: scope.timeZone },
	)
	if (withLinks) await printLinks(org.id, org.dataRegion)
	if (!result.seeded) {
		const reasons = {
			no_staff: `"${slug}" has no active staff at this scope. Run seed:staff first.`,
			shifts_exist: 'This scope already has shifts. Nothing added.',
			no_time_zone: 'The scope has no usable time zone.',
		}
		console.info(reasons[result.reason])
		return
	}
	console.info(
		`Seeded ${result.shifts} shifts for ${result.people} people: ` +
			`week of ${result.weekStart} published, ${result.nextWeekStart} as drafts.`,
	)
}

main()
	.then(() => process.exit(0))
	.catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : 'Seeding failed.')
		process.exit(1)
	})
