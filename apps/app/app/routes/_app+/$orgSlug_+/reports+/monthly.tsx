import {
	createForbiddenResponse,
	requireUserId,
	userHasOrganizationPermission,
} from '@repo/auth'
import {
	FIGURES,
	lastCompleteMonthKey,
	MONTH_KEY,
	MONTHLY_PRESET,
	monthlyAsOf,
	previousMonthKey,
	type FigureId,
} from '@repo/reports'
import { data, useLoaderData } from 'react-router'
import { MonthlyResultsScreen } from '#app/components/reports/monthly-results-screen.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import {
	resolveFigureModules,
	reviewFigureValue,
} from '#app/utils/reports/modules.server.ts'
import {
	partialMonthFor,
	planMonthlyFigures,
} from '#app/utils/reports/monthly.server.ts'
import { defaultReportingTimeZone } from '#app/utils/reports/schedules.server.ts'
import { resolveReportTokenGrants } from '#app/utils/reports/token-grants.server.ts'
import { resolveReportGrantsForRequest } from '#app/utils/staffing/report-grants.server.ts'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'
import { type Route } from './+types/monthly.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		dataRegion: true,
		hasProvisionedDb: true,
		createdAt: true,
		deliveryCommissionBp: true,
	})
	const grants = await resolveReportTokenGrants({
		request,
		userId,
		organizationId: organization.id,
	})
	if (!grants.hasAnyGrant) throw createForbiddenResponse('read:analytics:any')
	const timeZone = await defaultReportingTimeZone(organization.id)
	const latest = lastCompleteMonthKey(new Date())
	const asked = new URL(request.url).searchParams.get('month')
	// A month that has not finished has no summary yet; anything earlier is fine.
	const month =
		asked && MONTH_KEY.test(asked) && asked <= latest ? asked : latest
	const subjectGrants = await resolveReportGrantsForRequest(
		request,
		userId,
		organization.id,
	)
	const subjects = new Set<string>([
		...grants.subjects,
		...(subjectGrants.includes('reviews') ? ['reviews'] : []),
	])
	const modules = await resolveFigureModules(organization.id)
	const plan = planMonthlyFigures({
		grants: subjects,
		modulesOn: new Set(modules),
	})
	const regionIds = plan.shown.filter((id) => FIGURES[id].source === 'region')
	const reviews = []
	for (const id of plan.shown) {
		if (FIGURES[id].source !== 'control-plane') continue
		reviews.push(
			await reviewFigureValue({
				organizationId: organization.id,
				id: id as 'newReviews' | 'averageRating',
				preset: MONTHLY_PRESET,
				asOf: monthlyAsOf(month),
				timeZone,
			}),
		)
	}
	const canEditRate = await userHasOrganizationPermission(
		userId,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)
	const partial = partialMonthFor(month, organization.createdAt)
	const next = (() => {
		const [y, m] = month.split('-').map(Number) as [number, number]
		const key = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`
		return key <= latest ? key : null
	})()
	const { tenantApiUrl } = resolveRegionalTenantApiUrls(organization.dataRegion)
	return data({
		orgSlug: organization.slug,
		month,
		previousMonth: previousMonthKey(month),
		nextMonth: next,
		timeZone,
		tokenUrl: `/${organization.slug}/reports/token`,
		tenantApiUrl: organization.hasProvisionedDb ? tenantApiUrl : '',
		regionIds: organization.hasProvisionedDb ? (regionIds as FigureId[]) : [],
		reviews,
		off: plan.off,
		commissionBp: organization.deliveryCommissionBp,
		partialSince: partial?.since ?? null,
		canEditRate,
		showKept: subjects.has('sales') && regionIds.includes('onlineSales'),
	})
}

export default function MonthlyResultsRoute() {
	return <MonthlyResultsScreen data={useLoaderData<typeof loader>()} />
}
