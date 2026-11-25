import { Trans, useLingui } from '@lingui/react/macro'
import { requireUserId } from '@repo/auth'
import { and, asc, db, eq, inArray, OrganizationLocation } from '@repo/database'
import { WorkspacePage } from '@repo/ui/workspace'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useCallback, useEffect, useState } from 'react'
import { useLoaderData } from 'react-router'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { resolveReservationsLocationIds } from '#app/utils/reservations/access.server.ts'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'
import { formatPauseLength } from '#app/utils/location/missed-estimate.ts'
import { type Route } from './+types/online-uptime.ts'

const PRESETS = [
	'last_7_days',
	'last_14_days',
	'last_30_days',
	'last_complete_month',
	'last_3_months',
] as const
type Preset = (typeof PRESETS)[number]

type Breakdown = {
	scheduledMinutes: number
	minutes: { open: number; paused: number; dishes: number; closed: number }
	uptimePercent: number | null
}
type UptimeResult = {
	locations: Array<
		Breakdown & {
			locationId: string
			name: string
			days: Array<Breakdown & { date: string }>
		}
	>
	overall: Breakdown
	dishesKnown: boolean
}

export async function loader({ request, params }: Route.LoaderArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		dataRegion: true,
	})
	const locationIds = await resolveReservationsLocationIds(
		userId,
		organization.id,
	)
	const filter =
		locationIds === null
			? eq(OrganizationLocation.organizationId, organization.id)
			: locationIds.length === 0
				? eq(OrganizationLocation.id, '')
				: and(
						eq(OrganizationLocation.organizationId, organization.id),
						inArray(OrganizationLocation.id, locationIds),
					)
	const locations = await db
		.select({ id: OrganizationLocation.id, name: OrganizationLocation.name })
		.from(OrganizationLocation)
		.where(filter)
		.orderBy(asc(OrganizationLocation.name))
	const { tenantApiUrl } = resolveRegionalTenantApiUrls(organization.dataRegion)
	return {
		tokenUrl: `/${params.orgSlug}/reports/token`,
		tenantApiUrl,
		locations,
	}
}

function percent(value: number | null, locale: string) {
	if (value === null) return '—'
	return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)}%`
}

export default function OnlineUptimePage() {
	const { tokenUrl, tenantApiUrl, locations } = useLoaderData<typeof loader>()
	const { t, i18n } = useLingui()
	const [preset, setPreset] = useState<Preset>('last_30_days')
	const [locationId, setLocationId] = useState('')
	const [result, setResult] = useState<UptimeResult | null>(null)
	const [failed, setFailed] = useState(false)
	const [openLocation, setOpenLocation] = useState<string | null>(null)

	const load = useCallback(async () => {
		setFailed(false)
		setResult(null)
		try {
			const tokenResponse = await fetch(tokenUrl)
			const tokenBody = (await tokenResponse.json()) as { token?: string }
			if (!tokenResponse.ok || typeof tokenBody.token !== 'string') {
				throw new Error('token')
			}
			const query = new URLSearchParams({ preset })
			try {
				query.set('timeZone', Intl.DateTimeFormat().resolvedOptions().timeZone)
			} catch {
				// The region falls back to UTC.
			}
			if (locationId) query.set('locationIds', locationId)
			const response = await fetch(
				`${tenantApiUrl}/analytics/online-uptime?${query.toString()}`,
				{ headers: { Authorization: `Bearer ${tokenBody.token}` } },
			)
			if (!response.ok) throw new Error('run')
			setResult((await response.json()) as UptimeResult)
		} catch {
			setFailed(true)
		}
	}, [locationId, preset, tenantApiUrl, tokenUrl])

	useEffect(() => {
		void load()
	}, [load])

	const presetLabels: Record<Preset, string> = {
		last_7_days: t`Last 7 days`,
		last_14_days: t`Last 14 days`,
		last_30_days: t`Last 30 days`,
		last_complete_month: t`Last month`,
		last_3_months: t`Last 3 months`,
	}
	const minutes = (value: number) => formatPauseLength(value, i18n.locale)

	return (
		<WorkspacePage>
			<div className="flex flex-col gap-1">
				<h1 className="text-2xl font-semibold tracking-tight">
					<Trans>Online ordering uptime</Trans>
				</h1>
				<p className="text-muted-foreground max-w-2xl text-sm">
					<Trans>
						How much of the time you meant to be open, online ordering really
						was, and what stopped it. Only your scheduled open hours count, so
						closed nights are not downtime.
					</Trans>
				</p>
			</div>
			<div className="flex flex-wrap items-end gap-3">
				<label className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground text-xs">
						<Trans>Period</Trans>
					</span>
					<select
						className="bg-card border-input h-8 rounded-md border px-2 text-sm"
						value={preset}
						onChange={(event) => setPreset(event.target.value as Preset)}
					>
						{PRESETS.map((item) => (
							<option key={item} value={item}>
								{presetLabels[item]}
							</option>
						))}
					</select>
				</label>
				{locations.length > 1 ? (
					<label className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground text-xs">
							<Trans>Location</Trans>
						</span>
						<select
							className="bg-card border-input h-8 rounded-md border px-2 text-sm"
							value={locationId}
							onChange={(event) => setLocationId(event.target.value)}
						>
							<option value="">{t`All locations`}</option>
							{locations.map((location) => (
								<option key={location.id} value={location.id}>
									{location.name}
								</option>
							))}
						</select>
					</label>
				) : null}
			</div>
			{failed ? (
				<p className="text-destructive text-sm">
					<Trans>Could not load uptime just now. Try again in a moment.</Trans>
				</p>
			) : null}
			{result === null && !failed ? (
				<p className="text-muted-foreground text-sm">
					<Trans>Loading…</Trans>
				</p>
			) : null}
			{result ? (
				<div className="flex flex-col gap-4">
					{!result.dishesKnown ? (
						<p className="text-muted-foreground text-xs">
							<Trans>
								The menu could not be read, so time when no dish could be
								ordered is not shown separately.
							</Trans>
						</p>
					) : null}
					<div className="overflow-x-auto">
						<Table data-testid="uptime-table">
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>Location</Trans>
									</TableHead>
									<TableHead className="text-end">
										<Trans>Uptime</Trans>
									</TableHead>
									<TableHead className="text-end">
										<Trans>Scheduled</Trans>
									</TableHead>
									<TableHead className="text-end">
										<Trans>Paused by staff</Trans>
									</TableHead>
									<TableHead className="text-end">
										<Trans>Dishes unavailable</Trans>
									</TableHead>
									<TableHead className="text-end">
										<Trans>Closed unexpectedly</Trans>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{result.locations.map((location) => (
									<TableRow
										key={location.locationId}
										data-testid={`uptime-${location.locationId}`}
										onClick={() =>
											setOpenLocation(
												openLocation === location.locationId
													? null
													: location.locationId,
											)
										}
										className="cursor-pointer"
									>
										<TableCell className="font-medium">
											{location.name}
										</TableCell>
										<TableCell className="text-end tabular-nums">
											{percent(location.uptimePercent, i18n.locale)}
										</TableCell>
										<TableCell className="text-end tabular-nums">
											{minutes(location.scheduledMinutes)}
										</TableCell>
										<TableCell className="text-end tabular-nums">
											{minutes(location.minutes.paused)}
										</TableCell>
										<TableCell className="text-end tabular-nums">
											{minutes(location.minutes.dishes)}
										</TableCell>
										<TableCell className="text-end tabular-nums">
											{minutes(location.minutes.closed)}
										</TableCell>
									</TableRow>
								))}
								{result.locations.length > 1 ? (
									<TableRow className="font-semibold" data-testid="uptime-overall">
										<TableCell>
											<Trans>All locations</Trans>
										</TableCell>
										<TableCell className="text-end tabular-nums">
											{percent(result.overall.uptimePercent, i18n.locale)}
										</TableCell>
										<TableCell className="text-end tabular-nums">
											{minutes(result.overall.scheduledMinutes)}
										</TableCell>
										<TableCell className="text-end tabular-nums">
											{minutes(result.overall.minutes.paused)}
										</TableCell>
										<TableCell className="text-end tabular-nums">
											{minutes(result.overall.minutes.dishes)}
										</TableCell>
										<TableCell className="text-end tabular-nums">
											{minutes(result.overall.minutes.closed)}
										</TableCell>
									</TableRow>
								) : null}
							</TableBody>
						</Table>
					</div>
					{result.locations
						.filter(
							(location) =>
								openLocation === location.locationId ||
								result.locations.length === 1,
						)
						.map((location) => (
							<section
								key={location.locationId}
								className="flex flex-col gap-2"
								data-testid={`uptime-days-${location.locationId}`}
							>
								<h2 className="text-sm font-semibold">
									<Trans>Over time: {location.name}</Trans>
								</h2>
								<ul className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
									{location.days.map((day) => (
										<li
											key={day.date}
											className="flex items-baseline justify-between gap-3 border-b border-dashed py-1"
										>
											<span className="text-muted-foreground tabular-nums">
												{day.date}
											</span>
											<span className="tabular-nums">
												{percent(day.uptimePercent, i18n.locale)}
											</span>
										</li>
									))}
								</ul>
							</section>
						))}
				</div>
			) : null}
		</WorkspacePage>
	)
}
