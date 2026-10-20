/**
 * Seeds demo time clock data for local development, in one organization's
 * regional tenant database (never in the control plane):
 *
 *   npm run seed:timeclock -w tenant-api -- <org-slug> [--enable]
 *
 * - a starter labor policy as the organization default,
 * - a PIN for the first demo people (printed once; local development only),
 * - a paired demo tablet and today's punches: people clocked in, one on a
 *   break, one who never clocked out, and one who already went home,
 * - one fresh, unused pairing link for pairing a real browser as a kiosk.
 *
 * Behind the feature flags: it refuses unless `staffing.enabled` and
 * `staffing.timeclock` are on for the organization (`--enable` turns them
 * on). Run `npm run seed:staff` first for the roster. It is idempotent: when
 * punches already exist it adds nothing (punches are append-only, so there is
 * no reset), though it always prints a new pairing link.
 *
 * It goes through the same service functions as the API, so every row passes
 * the production validation and writes its audit record.
 */
import { and, ConfigFlag, db, eq, Organization } from '@repo/database'
import {
	BUILTIN_LABOR_POLICY,
	kioskPairingFragment,
	STAFFING_FLAG_KEYS,
	STAFFING_PERMISSION_LIST,
	type StaffingFeature,
} from '@repo/staffing'
import {
	getTenantDb,
	kioskDevices,
	staffJobs,
	staffScopeAssignments,
	staffMembers,
	timeEntries,
} from '@repo/tenant-db'
import { loadSeedScope } from './seed-scope.ts'
import { scopeToScopes, type StaffAuth } from '../src/lib/staff-auth.ts'
import {
	createPairingCode,
	redeemPairingCode,
} from '../src/services/kiosk-device-service.ts'
import { savePolicy } from '../src/services/labor-policy-service.ts'
import {
	defaultPunchDeps,
	processPunch,
	type PunchDeps,
} from '../src/services/punch-service.ts'
import { listStaff, setPin } from '../src/services/staff-service.ts'

function fail(message: string): never {
	console.error(message)
	process.exit(1)
}

const MIN = 60_000
const HOUR = 60 * MIN

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
			'seed-timeclock is for local development and refuses to run in production.',
		)
	}
	const args = process.argv.slice(2)
	const slug = args.find((arg) => !arg.startsWith('--'))
	const enable = args.includes('--enable')
	if (!slug) fail('Usage: seed-timeclock <org-slug> [--enable]')

	const [org] = await db
		.select({ id: Organization.id })
		.from(Organization)
		.where(eq(Organization.slug, slug))
		.limit(1)
	if (!org) fail(`No organization with slug "${slug}".`)
	await ensureFlag(org.id, 'enabled', enable, slug)
	await ensureFlag(org.id, 'timeclock', enable, slug)

	const scope = await loadSeedScope(org.id)

	const tenantDb = await getTenantDb(org.id)
	const auth: StaffAuth = {
		orgId: org.id,
		userId: 'seed-script',
		scope: 'timeclock',
		grants: STAFFING_PERMISSION_LIST,
		scopeIds: null,
		impersonated: false,
	}
	const ctx = {
		db: tenantDb,
		auth,
		scope: scopeToScopes(auth),
		ipHash: null,
	}

	const roster = await listStaff(ctx, {
		limit: 50,
		offset: 0,
		status: undefined,
	})
	if (roster.total === 0) {
		fail(`"${slug}" has no staff yet. Run seed:staff first.`)
	}

	// 1. The organization default policy, from starter values.
	const policy = await savePolicy(ctx, null, {
		lateGraceMinutes: 5,
		preventEarlyMinutes: 10,
		missedClockOutReminderMinutes: 30,
		longShiftMinutes: 12 * 60,
		timesheetApprovalMode: 'approve',
		aggregateOvertimeAcrossScopes: false,
		weekStartsOn: BUILTIN_LABOR_POLICY.weekStartsOn,
		breakRules: {
			rules: [
				{
					kind: 'meal',
					afterMinutes: 360,
					minutes: 30,
					paid: false,
					mandatory: false,
				},
			],
			autoDeduction: null,
		},
	})
	if (!policy.ok && policy.error !== 'stale_version') {
		console.info(`Labor policy not changed (${policy.error}).`)
	}

	// 2. A paired demo tablet, and a separate unused link for a real browser.
	const demoCode = await createPairingCode(ctx, {
		scopeId: scope.id,
		deviceName: 'Demo tablet',
		identifyMode: 'pin',
		showNextShifts: false,
		timeZone: scope.timeZone,
	})
	if (!demoCode.ok) fail(`Could not create a pairing code: ${demoCode.error}`)

	const existingEntries = await tenantDb
		.select({ id: timeEntries.id })
		.from(timeEntries)
		.limit(1)
	if (existingEntries.length > 0) {
		console.info('Punches already exist. Not adding demo punches.')
	} else {
		const paired = await redeemPairingCode(
			tenantDb,
			org.id,
			demoCode.value.code,
			null,
			Date.now(),
		)
		if (!paired) fail('Could not pair the demo tablet.')
		const [device] = await tenantDb
			.select()
			.from(kioskDevices)
			.where(eq(kioskDevices.id, paired.config.device.id))
			.limit(1)

		const people = roster.staff.slice(0, 6)
		const pins = new Map<string, string>()
		for (const person of people) {
			const [assignment] = await tenantDb
				.select()
				.from(staffScopeAssignments)
				.where(
					and(
						eq(staffScopeAssignments.staffId, person.id),
						eq(staffScopeAssignments.scopeId, scope.id),
					),
				)
				.limit(1)
			if (!assignment) continue
			const result = await setPin(ctx, person.id, assignment.id, undefined)
			if (result.ok) pins.set(person.id, result.value.pin)
		}

		let clock = Date.now()
		const deps: PunchDeps = { ...defaultPunchDeps, now: () => clock }
		async function punch(
			person: (typeof people)[number],
			kind: 'clock_in' | 'break_start' | 'break_end' | 'clock_out',
			at: number,
		) {
			clock = at
			const [member] = await tenantDb
				.select()
				.from(staffMembers)
				.where(eq(staffMembers.id, person.id))
				.limit(1)
			const [assignment] = await tenantDb
				.select()
				.from(staffScopeAssignments)
				.where(
					and(
						eq(staffScopeAssignments.staffId, person.id),
						eq(staffScopeAssignments.scopeId, scope!.id),
					),
				)
				.limit(1)
			const [job] = await tenantDb
				.select({ positionId: staffJobs.positionId })
				.from(staffJobs)
				.where(
					and(
						eq(staffJobs.staffId, person.id),
						eq(staffJobs.scopeId, scope!.id),
					),
				)
				.limit(1)
			if (!member || !assignment || !device) return
			const run = (positionId?: string) =>
				processPunch(
					tenantDb,
					{
						orgId: org!.id,
						device,
						assignment,
						member,
						ipHash: null,
						timeZone: scope!.timeZone,
					},
					{
						id: crypto.randomUUID(),
						kind,
						pin: '0000',
						clientAt: at,
						offline: false,
						...(positionId ? { positionId } : {}),
					},
					deps,
				)
			let outcome = await run()
			if (!outcome.ok && outcome.code === 'position_required' && job) {
				outcome = await run(job.positionId)
			}
			if (!outcome.ok) console.info(`  ${person.firstName}: ${outcome.code}`)
		}

		const now = Date.now()
		const [maya, luis, noor, tomas, priya] = people
		if (maya) await punch(maya, 'clock_in', now - 4 * HOUR)
		if (luis) {
			await punch(luis, 'clock_in', now - 3 * HOUR)
			await punch(luis, 'break_start', now - 10 * MIN)
		}
		if (noor) await punch(noor, 'clock_in', now - 2 * HOUR - 15 * MIN)
		if (priya) await punch(priya, 'clock_in', now - 19 * HOUR)
		if (tomas) {
			await punch(tomas, 'clock_in', now - 9 * HOUR)
			await punch(tomas, 'clock_out', now - 1 * HOUR)
		}
		console.info('Seeded demo punches. Demo PINs (local development only):')
		for (const person of people) {
			const pin = pins.get(person.id)
			if (pin) console.info(`  ${person.firstName}: ${pin}`)
		}
	}

	// 3. A fresh link for pairing a real browser as a kiosk.
	const browserCode = await createPairingCode(ctx, {
		scopeId: scope.id,
		deviceName: 'Browser tablet',
		identifyMode: 'pin',
		showNextShifts: false,
		timeZone: scope.timeZone,
	})
	if (browserCode.ok) {
		console.info(
			`Pair a browser (valid 10 minutes): <app origin>/kiosk/pair${kioskPairingFragment('us', browserCode.value.code)}`,
		)
	}
}

await main()
process.exit(0)
