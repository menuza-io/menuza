import { i18n } from '@lingui/core'
import { msg, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import { getHints } from '@repo/ui/client-hints'
import { Icon } from '@repo/ui/icon'
import { PageHeader } from '@repo/ui/page-header'
import {
	Link,
	useLoaderData,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { z } from 'zod'
import {
	MarketingCalendarGrid,
	OccasionList,
} from '#app/components/marketing/marketing-calendar.tsx'
import { useHasPermission } from '#app/hooks/use-organization-permissions.ts'
import {
	dismissOccasion,
	loadCalendar,
	restoreOccasion,
	setAutoSchedule,
} from '#app/utils/marketing/calendar.server.ts'
import { getMarketingFeatures } from '#app/utils/marketing/marketing-flags.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { dayKey, isMonthKey, shiftMonth } from '#app/utils/social/time.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

/**
 * Marketing, Calendar (#152): a month of scheduled broadcasts and social posts
 * with the occasions of the organization's market, each with a ready-made
 * campaign four weeks ahead. "Use this" opens a prefilled broadcast; Dismiss
 * hides an occasion for the year; Auto-schedule (off until turned on, per
 * occasion) has the daily job schedule the broadcast 14 days before the day.
 * Behind `marketing.calendar` (404 while it is off); using it needs
 * `update:campaign:any`. No guest data is read.
 */

export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const { orgId, fetchTenant } = await getOperatorTenantClient(request, orgSlug)
	await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.READ_CAMPAIGN_ANY,
	)
	if (!(await getMarketingFeatures(orgId)).calendar) {
		throw new Response('Not found', { status: 404 })
	}
	const { timeZone } = getHints(request)
	const today = dayKey(new Date(), timeZone)
	const requested = new URL(request.url).searchParams.get('month')
	const month = isMonthKey(requested) ? requested : today.slice(0, 7)
	return {
		orgSlug,
		month,
		today,
		timeZone,
		...(await loadCalendar({
			organizationId: orgId,
			month,
			today,
			timeZone,
			fetchTenant,
		})),
	}
}

const dismissSchema = z.object({
	intent: z.enum(['dismiss', 'restore']),
	key: z.string().min(1).max(60),
	year: z.coerce.number().int().min(2000).max(2100),
})
const autoSchema = z.object({
	intent: z.literal('auto'),
	key: z.string().min(1).max(60),
	on: z.enum(['true', 'false']),
	channel: z.enum(['email', 'sms']).optional(),
})

export async function action({ request, params }: ActionFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const { orgId } = await getOperatorTenantClient(request, orgSlug)
	await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.UPDATE_CAMPAIGN_ANY,
	)
	if (!(await getMarketingFeatures(orgId)).calendar) {
		throw new Response('Not found', { status: 404 })
	}
	const form = Object.fromEntries(await request.formData())

	const choice = dismissSchema.safeParse(form)
	if (choice.success) {
		const done =
			choice.data.intent === 'dismiss'
				? await dismissOccasion({
						organizationId: orgId,
						key: choice.data.key,
						year: choice.data.year,
					})
				: await restoreOccasion({
						organizationId: orgId,
						key: choice.data.key,
						year: choice.data.year,
					})
		return done
			? { ok: true as const }
			: { error: i18n._(t`That occasion is not on the calendar.`) }
	}

	const auto = autoSchema.safeParse(form)
	if (auto.success) {
		const done = await setAutoSchedule({
			organizationId: orgId,
			key: auto.data.key,
			on: auto.data.on === 'true',
			channel: auto.data.channel,
		})
		return done
			? { ok: true as const }
			: { error: i18n._(t`That occasion is not on the calendar.`) }
	}
	return { error: i18n._(t`Something went wrong. Please try again.`) }
}

export default function MarketingCalendar() {
	const { _, i18n: lingui } = useLingui()
	const {
		orgSlug,
		month,
		today,
		timeZone,
		market,
		occasions,
		suggestions,
		broadcasts,
		posts,
	} = useLoaderData<typeof loader>()
	const hasPermission = useHasPermission()
	const canWrite = hasPermission('update:campaign:any')
	const [year, monthNumber] = month.split('-').map(Number) as [number, number]
	const monthLabel = new Intl.DateTimeFormat(lingui.locale, {
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC',
	}).format(new Date(Date.UTC(year, monthNumber - 1, 1)))
	const monthLink = (target: string) => `?month=${target}`
	return (
		<div className="space-y-8">
			<PageHeader
				title={_(msg`Calendar`)}
				description={
					market === 'ksa'
						? _(
								msg`Your broadcasts, your posts and the occasions of Saudi Arabia, with a campaign ready for each.`,
							)
						: _(
								msg`Your broadcasts, your posts and the occasions of the United States, with a campaign ready for each.`,
							)
				}
				actions={
					<Button
						variant="outline"
						render={<Link to={`/${orgSlug}/marketing/settings`} />}
					>
						<Icon name="settings" />
						{_(msg`Settings`)}
					</Button>
				}
			/>

			<section className="space-y-3" aria-labelledby="coming-up">
				<h2 id="coming-up" className="text-lg font-medium">
					{_(msg`Coming up in the next four weeks`)}
				</h2>
				<OccasionList
					occasions={suggestions}
					orgSlug={orgSlug}
					canWrite={canWrite}
				/>
			</section>

			<section className="space-y-3">
				<div className="flex items-center gap-2">
					<Button
						variant="outline"
						size="icon-sm"
						render={<Link to={monthLink(shiftMonth(month, -1))} />}
						aria-label={_(msg`Previous month`)}
					>
						<Icon name="chevron-left" className="rtl:rotate-180" />
					</Button>
					<Button
						variant="outline"
						size="icon-sm"
						render={<Link to={monthLink(shiftMonth(month, 1))} />}
						aria-label={_(msg`Next month`)}
					>
						<Icon name="chevron-right" className="rtl:rotate-180" />
					</Button>
					<h2 className="ms-1 text-lg font-medium" aria-live="polite">
						{monthLabel}
					</h2>
					{month !== today.slice(0, 7) ? (
						<Button
							variant="ghost"
							size="sm"
							render={<Link to={monthLink(today.slice(0, 7))} />}
						>
							{_(msg`Today`)}
						</Button>
					) : null}
				</div>
				<MarketingCalendarGrid
					month={month}
					today={today}
					timeZone={timeZone}
					orgSlug={orgSlug}
					occasions={occasions}
					broadcasts={broadcasts}
					posts={posts}
				/>
			</section>
		</div>
	)
}
