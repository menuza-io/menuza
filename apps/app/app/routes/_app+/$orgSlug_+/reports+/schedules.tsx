import { requireUserId } from '@repo/auth'
import { REPORT_SCHEDULE_LIMITS } from '@repo/reports/schedule'
import { parseDefinition } from '@repo/reports/server'
import {
	personalFieldsUsed,
	definitionAllowed,
} from '@repo/reports'
import { db, and, asc, eq, SavedReport, User, UserOrganization } from '@repo/database'
import { data, useLoaderData } from 'react-router'
import { ReportSchedulesScreen } from '#app/components/reports/report-schedules-screen.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import {
	createReportSchedule,
	defaultReportingTimeZone,
	deleteReportSchedule,
	isReportSchedulesEnabled,
	listReportSchedules,
	setReportSchedulePaused,
	updateReportSchedule,
} from '#app/utils/reports/schedules.server.ts'
import { resolveReportGrantsForRequest } from '#app/utils/staffing/report-grants.server.ts'
import { organizationReportCatalog } from '#app/utils/staffing/restaurant/report-catalog.server.ts'
import { type Route } from './+types/schedules.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	const userId = await requireUserWithOrganizationPermissionFor(request, params.orgSlug)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})
	const enabled = await isReportSchedulesEnabled(organization.id)
	const [schedules, defaultTimeZone] = await Promise.all([
		enabled ? listReportSchedules(organization.id) : [],
		defaultReportingTimeZone(organization.id),
	])
	const grants = await resolveReportGrantsForRequest(request, userId, organization.id)
	const { catalog } = await organizationReportCatalog(organization.id)
	const saved = await db
		.select()
		.from(SavedReport)
		.where(
			and(
				eq(SavedReport.organizationId, organization.id),
				eq(SavedReport.scope, 'organization'),
			),
		)
		.orderBy(asc(SavedReport.title))
	const reports = saved
		.map((report) => ({ report, definition: parseDefinition(report.definition) }))
		.filter(({ definition }) => definitionAllowed(catalog, definition, grants))
		.map(({ report, definition }) => ({
			id: report.id,
			title: report.title,
			personal: personalFieldsUsed(catalog, definition).length > 0,
		}))
	const members = await db
		.select({ id: User.id, name: User.name, email: User.email })
		.from(UserOrganization)
		.innerJoin(User, eq(User.id, UserOrganization.userId))
		.where(
			and(
				eq(UserOrganization.organizationId, organization.id),
				eq(UserOrganization.active, true),
			),
		)
		.orderBy(asc(User.email))
	const url = new URL(request.url)
	const asked = url.searchParams.get('report')
	return data({
		orgSlug: organization.slug,
		enabled,
		schedules: schedules.map((s) => ({
			...s,
			pausedAt: s.pausedAt?.toISOString() ?? null,
			lastSentAt: s.lastSentAt?.toISOString() ?? null,
		})),
		reports,
		members,
		defaultTimeZone,
		initialReport:
			asked === 'daily_summary' || reports.some((r) => r.id === asked)
				? asked
				: null,
	})
}

/** Scheduling needs the analytics grant (and the flag, checked by each write). */
async function requireUserWithOrganizationPermissionFor(
	request: Request,
	orgSlug: string | undefined,
) {
	const organization = await requireUserOrganization(request, orgSlug, { id: true })
	await requireUserId(request)
	return requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_ANALYTICS_ANY,
	)
}

export async function action({ request, params }: Route.ActionArgs) {
	const userId = await requireUserWithOrganizationPermissionFor(request, params.orgSlug)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
	})
	const body = (await request.json().catch(() => null)) as Record<
		string,
		unknown
	> | null
	if (!body || typeof body.intent !== 'string') {
		return data({ ok: false, error: 'invalid_request' }, { status: 400 })
	}
	const input = {
		savedReportId:
			typeof body.savedReportId === 'string' ? body.savedReportId : null,
		cadence: body.cadence as 'daily' | 'weekly' | 'monthly',
		weekday: typeof body.weekday === 'number' ? body.weekday : null,
		hour: Number(body.hour),
		timeZone: String(body.timeZone ?? ''),
		locale: body.locale === 'ar' ? ('ar' as const) : ('en' as const),
		recipientUserIds: Array.isArray(body.recipientUserIds)
			? body.recipientUserIds.filter((id): id is string => typeof id === 'string')
			: [],
	}
	const id = typeof body.id === 'string' ? body.id : ''
	let result
	switch (body.intent) {
		case 'create':
			result = await createReportSchedule({
				organizationId: organization.id,
				userId,
				request,
				schedule: input,
			})
			break
		case 'update':
			result = await updateReportSchedule({
				organizationId: organization.id,
				userId,
				request,
				scheduleId: id,
				schedule: input,
			})
			break
		case 'pause':
		case 'resume':
			result = await setReportSchedulePaused({
				organizationId: organization.id,
				scheduleId: id,
				paused: body.intent === 'pause',
			})
			break
		case 'delete':
			result = await deleteReportSchedule({
				organizationId: organization.id,
				scheduleId: id,
			})
			break
		default:
			return data({ ok: false, error: 'invalid_request' }, { status: 400 })
	}
	return result.ok
		? data({ ok: true })
		: data(
				{ ok: false, error: result.error, detail: result.detail },
				{ status: 422 },
			)
}

export default function ReportSchedulesRoute() {
	const loaded = useLoaderData<typeof loader>()
	return (
		<ReportSchedulesScreen
			{...loaded}
			limits={{
				schedules: REPORT_SCHEDULE_LIMITS.schedulesPerOrganization,
				recipients: REPORT_SCHEDULE_LIMITS.recipientsPerSchedule,
			}}
		/>
	)
}
