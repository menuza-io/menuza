/**
 * Seeds a demo roster for local development: six positions and a dozen
 * made-up staff for one organization, in that organization's regional tenant
 * database (never in the control plane).
 *
 *   npm run seed:staff -w tenant-api -- <org-slug> [--enable] [--reset-positions]
 *
 * Behind the feature flag: the script refuses to run unless `staffing.enabled`
 * is on for the organization. Pass `--enable` to turn it on (an organization
 * level ConfigFlag row, the same one Admin sets). It is idempotent: if the
 * roster already has people it stops without changing anything.
 *
 * It goes through the same service functions as the API, so every row passes
 * the production validation and writes its audit record.
 */
import { and, ConfigFlag, db, eq, Organization } from '@repo/database'
import {
	STAFFING_FLAG_KEYS,
	STAFFING_PERMISSION_LIST,
	type StaffingCurrency,
} from '@repo/staffing'
import { DEMO_POSITIONS, DEMO_STAFF } from '@repo/staffing/demo-roster'
import {
	getTenantDb,
	hiringApplications,
	provisionTenantDb,
	type TenantDatabase,
} from '@repo/tenant-db'
import { loadSeedScope } from './seed-scope.ts'
import { scopeToScopes, type StaffAuth } from '../src/lib/staff-auth.ts'
import {
	createJob,
	createPosition,
	createStaff,
	listPositions,
	listStaff,
	type StaffContext,
} from '../src/services/staff-service.ts'

/**
 * Two made-up applicants for the pipeline (one with a screening flag), so the
 * Applicants screen has something to show. The job id is a placeholder: the
 * posting itself lives in the control plane. Skipped when any exist.
 */
async function seedApplicants(db: TenantDatabase, scopeId: string) {
	const [any] = await db
		.select({ id: hiringApplications.id })
		.from(hiringApplications)
		.limit(1)
	if (any) return
	const answers = (weekends: 'yes' | 'no') => [
		{
			id: 'weekends',
			kind: 'yes_no' as const,
			prompt: 'Can you work weekends?',
			category: 'availability',
			answer: weekends,
			requiredAnswer: 'yes' as const,
			dealbreaker: true,
		},
		{
			id: 'about',
			kind: 'open' as const,
			prompt: 'Tell us about your experience',
			answer: 'Two years on a busy grill station.',
		},
	]
	const now = Date.now()
	await db.insert(hiringApplications).values([
		{
			postingId: 'demo-line-cook',
			postingSlug: 'line-cook',
			postingTitle: 'Line cook',
			positionName: 'Line cook',
			scopeId,
			firstName: 'Amira',
			lastName: 'Demo',
			email: 'amira.demo@example.com',
			answers: answers('yes'),
			screenerScore: 100,
			consentAt: now,
			consentVersion: '2026-10',
		},
		{
			postingId: 'demo-line-cook',
			postingSlug: 'line-cook',
			postingTitle: 'Line cook',
			positionName: 'Line cook',
			scopeId,
			firstName: 'Bilal',
			lastName: 'Demo',
			phone: '+14155550123',
			stage: 'screening',
			answers: answers('no'),
			screenerScore: 50,
			screenerFlags: ['weekends'],
			consentAt: now,
			consentVersion: '2026-10',
		},
	])
	console.info('Added 2 demo applicants.')
}

function fail(message: string): never {
	console.error(message)
	process.exit(1)
}

async function main() {
	// Demo people must never land in a real organization's regional database.
	if (process.env.NODE_ENV === 'production') {
		fail(
			'seed-staff is for local development and refuses to run in production.',
		)
	}
	const args = process.argv.slice(2)
	const slug = args.find((arg) => !arg.startsWith('--'))
	const enable = args.includes('--enable')
	if (!slug) fail('Usage: seed-staff <org-slug> [--enable]')

	const [org] = await db
		.select({ id: Organization.id, name: Organization.name })
		.from(Organization)
		.where(eq(Organization.slug, slug))
		.limit(1)
	if (!org) fail(`No organization with slug "${slug}".`)

	const flagWhere = and(
		eq(ConfigFlag.key, STAFFING_FLAG_KEYS.enabled),
		eq(ConfigFlag.level, 'organization'),
		eq(ConfigFlag.organizationId, org.id),
	)
	const [flag] = await db.select().from(ConfigFlag).where(flagWhere).limit(1)
	if (flag?.value !== true) {
		if (!enable) {
			fail(
				`Staffing is off for "${slug}" (${STAFFING_FLAG_KEYS.enabled}). ` +
					'Run again with --enable to turn it on for this organization.',
			)
		}
		if (flag) {
			await db.update(ConfigFlag).set({ value: true }).where(flagWhere)
		} else {
			await db.insert(ConfigFlag).values({
				key: STAFFING_FLAG_KEYS.enabled,
				value: true,
				level: 'organization',
				organizationId: org.id,
			})
		}
		console.info(`Turned on ${STAFFING_FLAG_KEYS.enabled} for "${slug}".`)
	}

	const home = await loadSeedScope(org.id)
	const currency: StaffingCurrency = 'USD'

	await provisionTenantDb(org.id)
	const tenantDb = await getTenantDb(org.id)
	const auth: StaffAuth = {
		orgId: org.id,
		userId: 'seed-script',
		scope: 'staff',
		grants: STAFFING_PERMISSION_LIST,
		scopeIds: null,
		impersonated: false,
	}
	const ctx: StaffContext = {
		db: tenantDb,
		auth,
		scope: scopeToScopes(auth),
		ipHash: null,
	}

	await seedApplicants(tenantDb, home.id)

	const existing = await listStaff(ctx, {
		limit: 1,
		offset: 0,
		status: undefined,
	})
	if (existing.total > 0) {
		console.info(
			`"${slug}" already has ${existing.total} staff. Nothing to do.`,
		)
		return
	}

	const known = new Map(
		(await listPositions(ctx, { includeArchived: true })).positions.map(
			(position) => [position.name, position.id],
		),
	)
	for (const position of DEMO_POSITIONS) {
		if (known.has(position.name)) continue
		const created = await createPosition(ctx, { ...position, currency })
		if (!created.ok) fail(`Could not add ${position.name}: ${created.error}`)
		known.set(position.name, created.value.position.id)
	}

	const today = new Date().toISOString().slice(0, 10)
	const startedOn = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`
	let added = 0
	for (const person of DEMO_STAFF) {
		const { positions, rateMinor, ...input } = person
		const created = await createStaff(
			ctx,
			{
				...input,
				workerType: 'employee',
				locale: 'en',
				hiredDate: startedOn,
				assignments: [
					{
						scopeId: home.id,
						isPrimary: true,
						showInSchedule: true,
						eligibleOpenShifts: true,
						includeInClockErrors: true,
						canWaiveBreaks: false,
					},
				],
			},
			{ source: 'manual' },
		)
		if (!created.ok) fail(`Could not add ${person.firstName}: ${created.error}`)
		for (const [index, positionName] of positions.entries()) {
			const positionId = known.get(positionName)
			if (!positionId) fail(`Unknown demo position ${positionName}.`)
			const job = await createJob(ctx, created.value.staff.id, {
				scopeId: home.id,
				positionId,
				payType: 'hourly',
				// Only the main position carries a personal rate override.
				rateMinor: index === 0 && rateMinor ? rateMinor : null,
				annualSalaryMinor: null,
				currency,
				overtimeExempt: false,
				tipEligible: false,
				isPrimary: index === 0,
				effectiveFrom: startedOn,
			})
			if (!job.ok)
				fail(`Could not add a position for ${person.firstName}: ${job.error}`)
		}
		added += 1
	}
	console.info(
		`Seeded ${added} staff and ${DEMO_POSITIONS.length} positions at "${home.name}" for "${slug}".`,
	)
}

await main()
process.exit(0)
