import { msg, Plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { addDays, localDateOf, startOfWeek } from '@repo/staffing'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import {
	data,
	type LoaderFunctionArgs,
	redirect,
	useLoaderData,
	useSearchParams,
} from 'react-router'
import { staffingErrorMessage } from '#app/components/staffing/staffing-errors.ts'
import { useStaffingClient } from '#app/hooks/use-staffing-client.ts'
import { getStaffingAccess } from '#app/utils/staffing/access.server.ts'
import {
	contextSchema,
	formatCents,
	formatHours,
	formatPercent,
	formatWallDate,
	type LaborSummary,
	laborSummarySchema,
} from '#app/utils/staffing/client.ts'
import { loadStaffingLocations } from '#app/utils/staffing/locations.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await getStaffingAccess(request, params.orgSlug)
	if (!access.flags.enabled) throw new Response('Not found', { status: 404 })
	const base = `/${params.orgSlug}/staffing`
	if (!access.canViewPay) {
		if (access.grants.staff) return redirect(`${base}/team`)
		if (access.grants.schedule) return redirect(`${base}/schedule`)
		if (access.grants.timeclock) return redirect(`${base}/timesheets`)
		throw new Response('Forbidden', { status: 403 })
	}
	const locations = await loadStaffingLocations(access.orgId)
	return data(
		{
			orgSlug: params.orgSlug || '',
			locations: locations.filter((location) => location.isActive),
		},
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function Metric({
	label,
	value,
	detail,
}: {
	label: ReactNode
	value: string
	detail?: ReactNode
}) {
	return (
		<div className="rounded-lg border p-4">
			<dt className="text-muted-foreground text-sm">{label}</dt>
			<dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
			{detail ? (
				<dd className="text-muted-foreground mt-1 text-xs">{detail}</dd>
			) : null}
		</div>
	)
}

export default function StaffingOverview() {
	const { orgSlug, locations } = useLoaderData<typeof loader>()
	const { _, i18n } = useLingui()
	const request = useStaffingClient(orgSlug)
	const [searchParams, setSearchParams] = useSearchParams()
	const location =
		locations.find((item) => item.id === searchParams.get('location')) ??
		locations[0] ??
		null
	const requestedDate = searchParams.get('date')
	const anchor =
		requestedDate && DATE_RE.test(requestedDate)
			? requestedDate
			: location
				? localDateOf(new Date(), location.timezone)
				: null
	const [weekStartSetting, setWeekStartSetting] = useState<
		'monday' | 'sunday' | null
	>(null)
	const from =
		anchor && weekStartSetting ? startOfWeek(anchor, weekStartSetting) : null
	const to = from ? addDays(from, 6) : null
	const [summary, setSummary] = useState<LaborSummary | null>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		const controller = new AbortController()
		request('/context', { signal: controller.signal })
			.then((body) => {
				if (!controller.signal.aborted) {
					setWeekStartSetting(contextSchema.parse(body).settings.weekStart)
				}
			})
			.catch((caught: unknown) => {
				if (controller.signal.aborted) return
				setWeekStartSetting('monday')
				setError(staffingErrorMessage(i18n, caught))
			})
		return () => controller.abort()
	}, [request, i18n])

	const refresh = useCallback(
		async (signal: AbortSignal) => {
			if (!location || !from || !to) return
			try {
				const query = new URLSearchParams({ locationId: location.id, from, to })
				const body = await request(`/labor-summary?${query}`, { signal })
				if (signal.aborted) return
				setSummary(laborSummarySchema.parse(body).summary)
				setError(null)
			} catch (caught) {
				if (!signal.aborted) setError(staffingErrorMessage(i18n, caught))
			}
		},
		[request, i18n, location, from, to],
	)

	useEffect(() => {
		const controller = new AbortController()
		void refresh(controller.signal)
		return () => controller.abort()
	}, [refresh])

	if (!location) {
		return (
			<p className="bg-muted rounded-md p-3 text-sm">
				<Trans>
					Add an active location in Settings → Locations to see labor.
				</Trans>
			</p>
		)
	}

	const navigate = (next: { location?: string; date?: string }) => {
		const params = new URLSearchParams(searchParams)
		if (next.location) params.set('location', next.location)
		if (next.date) params.set('date', next.date)
		setSearchParams(params, { replace: true })
	}

	const current =
		summary && summary.from === from && summary.locationId === location.id
			? summary
			: null
	const today = localDateOf(new Date(), location.timezone)
	const money = (cents: number | null) =>
		cents === null || !current?.currency
			? '—'
			: formatCents(i18n.locale, cents, current.currency)
	const percent = (value: number | null) =>
		value === null ? '—' : formatPercent(i18n.locale, value)
	const weekLabel =
		from && to
			? `${formatWallDate(i18n.locale, from, { month: 'short', day: 'numeric' })} – ${formatWallDate(
					i18n.locale,
					to,
					{ month: 'short', day: 'numeric', year: 'numeric' },
				)}`
			: ''
	const totals = current?.totals
	const scheduledHours = formatHours(i18n.locale, totals?.scheduledMinutes ?? 0)
	const scheduledCost = money(totals?.scheduledLaborCents ?? null)
	const scheduledPercent = percent(totals?.scheduledLaborPercent ?? null)
	const orderCount = totals?.orderCount ?? 0
	const unratedHours = formatHours(
		i18n.locale,
		current?.unratedWorkedMinutes ?? 0,
	)
	const openEntries = current?.openEntries ?? 0

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-center gap-2">
				{locations.length > 1 ? (
					<select
						aria-label={_(msg`Location`)}
						className="border-input bg-background h-9 rounded-md border px-2 text-sm"
						value={location.id}
						onChange={(event) => navigate({ location: event.target.value })}
					>
						{locations.map((item) => (
							<option key={item.id} value={item.id}>
								{item.name}
							</option>
						))}
					</select>
				) : null}
				<div className="flex items-center gap-1">
					<Button
						size="sm"
						variant="outline"
						aria-label={_(msg`Previous week`)}
						onClick={() => from && navigate({ date: addDays(from, -7) })}
					>
						<Icon name="chevron-left" className="size-4 rtl:rotate-180" />
					</Button>
					<Button
						size="sm"
						variant="outline"
						onClick={() => navigate({ date: today })}
					>
						<Trans>This week</Trans>
					</Button>
					<Button
						size="sm"
						variant="outline"
						aria-label={_(msg`Next week`)}
						onClick={() => from && navigate({ date: addDays(from, 7) })}
					>
						<Icon name="chevron-right" className="size-4 rtl:rotate-180" />
					</Button>
				</div>
				<h2 className="text-sm font-medium">{weekLabel}</h2>
				<Badge variant="outline">
					<Trans>Online sales only</Trans>
				</Badge>
			</div>

			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : null}

			{!current ? (
				error ? null : (
					<p role="status">
						<Trans>Loading labor…</Trans>
					</p>
				)
			) : (
				<>
					<dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
						<Metric
							label={<Trans>Hours worked</Trans>}
							value={formatHours(i18n.locale, current.totals.workedMinutes)}
							detail={<Trans>{scheduledHours} scheduled</Trans>}
						/>
						<Metric
							label={<Trans>Labor cost</Trans>}
							value={money(current.totals.laborCents)}
							detail={<Trans>{scheduledCost} scheduled</Trans>}
						/>
						<Metric
							label={<Trans>Online sales</Trans>}
							value={money(current.totals.salesCents)}
							detail={
								<Plural
									value={orderCount}
									one="# order, before tax, delivery, and tips"
									other="# orders, before tax, delivery, and tips"
								/>
							}
						/>
						<Metric
							label={<Trans>Labor as % of online sales</Trans>}
							value={percent(current.totals.laborPercent)}
							detail={<Trans>{scheduledPercent} scheduled</Trans>}
						/>
					</dl>

					<div className="text-muted-foreground space-y-1 text-sm">
						<p>
							<Trans>
								Dine-in and in-store POS sales are not recorded here, so the
								labor percentage is higher than your true labor cost percentage.
								Labor cost is an estimate from hourly rates without taxes,
								benefits, or overtime premiums.
							</Trans>
						</p>
						{current.mixedCurrency ? (
							<p role="status" className="text-destructive">
								<Trans>
									Rates or orders at this location use more than one currency,
									so amounts are not added up.
								</Trans>
							</p>
						) : null}
						{current.unratedWorkedMinutes > 0 ? (
							<p role="status">
								<Trans>
									{unratedHours} worked hours have no pay rate and are not in
									labor cost. Set rates with Pay on the Team page.
								</Trans>
							</p>
						) : null}
						{openEntries > 0 ? (
							<p role="status">
								<Plural
									value={openEntries}
									one="# open time card is not counted until it is clocked out."
									other="# open time cards are not counted until they are clocked out."
								/>
							</p>
						) : null}
					</div>

					<div className="overflow-x-auto rounded-lg border">
						<table className="w-full border-collapse text-sm">
							<thead className="bg-muted/50 text-xs">
								<tr>
									<th scope="col" className="p-2 text-start font-medium">
										<Trans>Day</Trans>
									</th>
									<th scope="col" className="p-2 text-end font-medium">
										<Trans>Scheduled hours</Trans>
									</th>
									<th scope="col" className="p-2 text-end font-medium">
										<Trans>Hours worked</Trans>
									</th>
									<th scope="col" className="p-2 text-end font-medium">
										<Trans>Labor cost</Trans>
									</th>
									<th scope="col" className="p-2 text-end font-medium">
										<Trans>Online sales</Trans>
									</th>
									<th scope="col" className="p-2 text-end font-medium">
										<Trans>Orders</Trans>
									</th>
									<th scope="col" className="p-2 text-end font-medium">
										<Trans>Labor %</Trans>
									</th>
								</tr>
							</thead>
							<tbody className="divide-border divide-y">
								{current.days.map((day) => (
									<tr key={day.date}>
										<th scope="row" className="p-2 text-start font-medium">
											{formatWallDate(i18n.locale, day.date)}
										</th>
										<td className="p-2 text-end tabular-nums">
											{formatHours(i18n.locale, day.scheduledMinutes)}
										</td>
										<td className="p-2 text-end tabular-nums">
											{formatHours(i18n.locale, day.workedMinutes)}
										</td>
										<td className="p-2 text-end tabular-nums">
											{money(day.laborCents)}
										</td>
										<td className="p-2 text-end tabular-nums">
											{money(day.salesCents)}
										</td>
										<td className="p-2 text-end tabular-nums">
											{day.orderCount}
										</td>
										<td className="p-2 text-end tabular-nums">
											{percent(day.laborPercent)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</>
			)}
		</div>
	)
}
