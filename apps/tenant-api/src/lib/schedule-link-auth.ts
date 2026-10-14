import { type Context } from 'hono'
import { eq } from 'drizzle-orm'
import {
	parseScheduleLinkToken,
	type ScheduleLinkErrorCode,
} from '@repo/staffing'
import {
	getTenantDb,
	staffMembers,
	type ScheduleLinkRow,
	type StaffMember,
	type TenantDatabase,
} from '@repo/tenant-db'
import {
	checkScheduleLink,
	touchScheduleLink,
} from '../services/schedule-link-service.ts'
import { describeStaffError, hashClientIp } from '../services/staff-audit.ts'
import { getStaffingFeatures } from './scope-context.ts'
import { orgMatchesNodeRegion } from './region.ts'
import { getBearerToken } from './secrets.ts'

/**
 * The principal behind a "my schedule" link. The token is an opaque,
 * organization-prefixed bearer credential (`slk1.<org>.<link>.<secret>`) that is
 * only ever stored as a keyed hash. It opens one person's own published
 * schedule, time cards and requests, and nothing else: it can never be used on
 * an operator or kiosk route, and neither of those credentials is accepted here.
 *
 * Authentication touches only the organization's own regional database plus the
 * feature-flag lookup, so a link keeps working through a control-plane outage
 * that is shorter than the flag cache. An unknown link and a wrong secret answer
 * identically; a revoked or expired link gets its own code so the page can say
 * so; the organization's flags are checked on every call (the module being off
 * ends every link at once).
 */

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export function linkError(
	status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503,
	error: ScheduleLinkErrorCode | string,
	extra: Record<string, unknown> = {},
	headers: Record<string, string> = {},
) {
	return Response.json(
		{ error, ...extra },
		{ status, headers: { ...NO_STORE, ...headers } },
	)
}

export type ScheduleLinkAuth = {
	orgId: string
	db: TenantDatabase
	link: ScheduleLinkRow
	staff: StaffMember
	ipHash: string | null
}

export type ScheduleLinkAuthDeps = {
	now: () => number
}

type Failure = { error: Response }
type Success = { principal: ScheduleLinkAuth }

export async function authenticateScheduleLink(
	c: Context,
	deps: ScheduleLinkAuthDeps,
): Promise<Success | Failure> {
	const token = getBearerToken(c.req.header('Authorization'))
	const parsed = parseScheduleLinkToken(token)
	if (!parsed) return { error: linkError(401, 'invalid_link') }

	let db: TenantDatabase
	try {
		db = await getTenantDb(parsed.orgId)
	} catch {
		// No database for this organization on this node.
		return { error: linkError(401, 'invalid_link') }
	}

	const now = deps.now()
	let checked: Awaited<ReturnType<typeof checkScheduleLink>>
	try {
		checked = await checkScheduleLink(db, token, parsed.linkId, now)
	} catch (error) {
		console.error('Schedule link check failed', describeStaffError(error))
		return { error: linkError(500, 'Internal Server Error') }
	}
	if (!checked.ok) return { error: linkError(401, checked.code) }
	const { link } = checked

	const [staff] = await db
		.select()
		.from(staffMembers)
		.where(eq(staffMembers.id, link.staffId))
		.limit(1)
	if (!staff || staff.status === 'terminated') {
		return { error: linkError(401, 'staff_inactive') }
	}

	// The module's own switches end every link at once, and fail closed.
	const flags = await getStaffingFeatures(parsed.orgId, now).catch(() => null)
	if (!flags || !flags.features.enabled || !flags.features.scheduling) {
		return { error: linkError(403, 'schedule_disabled') }
	}
	if (flags.dataRegion !== null && !orgMatchesNodeRegion(flags.dataRegion)) {
		return { error: linkError(403, 'schedule_disabled') }
	}

	try {
		await touchScheduleLink(db, link, now)
	} catch (error) {
		// Presence is best effort; never fail a read over it.
		console.warn(
			'Schedule link: could not record use',
			describeStaffError(error),
		)
	}
	return {
		principal: {
			orgId: parsed.orgId,
			db,
			link,
			staff,
			ipHash: hashClientIp(c),
		},
	}
}
