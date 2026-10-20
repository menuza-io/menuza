import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { pickLocalized } from '@repo/common/site-locales'
import { cn } from '@repo/ui'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Item, ItemGroup } from '@repo/ui/item'
import { Skeleton } from '@repo/ui/skeleton'
import { Spinner } from '@repo/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import { FilterSelect } from '#app/components/staff/controls.tsx'
import { StaffAvatar } from '#app/components/staff/staff-avatar.tsx'
import { useLiveNow, useVisiblePolling } from '#app/hooks/use-live-clock.ts'
import { useStaffClient, useStaffQuery } from '#app/hooks/use-staff-client.ts'
import { describeStaffError } from '#app/utils/staffing/staff-errors.ts'
import {
	formatClockDateTime,
	formatClockTime,
	formatDuration,
	formatRelativeTime,
	minutesBetween,
} from '#app/utils/staffing/timeclock-format.ts'
import {
	filterTodayRows,
	sortTodayRows,
	summarizeToday,
	TODAY_FILTERS,
	type TodayFilter,
} from '#app/utils/staffing/timeclock-today.ts'
import {
	todayResponseSchema,
	type TodayRecentRow,
	type TodayRow,
} from '#app/utils/staffing/timeclock-types.ts'

type ScopeOption = { id: string; name: string }

const POLL_MS = 30_000

/**
 * Today at a glance: who is clocked in, who is on a break, who is late or
 * forgot to clock out. It reads straight from the regional time clock, keeps
 * itself fresh while the tab is open, and shows names and times only.
 */
export function TimeclockToday({
	orgSlug,
	scopes,
	canManageTablets,
}: {
	orgSlug: string
	scopes: readonly ScopeOption[]
	canManageTablets: boolean
}) {
	const { _, i18n } = useLingui()
	const { client, ready, unavailable } = useStaffClient('timeclock')
	const [scopeId, setScopeId] = useState('all')
	const [filter, setFilter] = useState<TodayFilter>('all')

	const scopeNames = useMemo(
		() =>
			new Map(
				scopes.map((scope) => [
					scope.id,
					pickLocalized(scope.name, i18n.locale, 'en') || scope.name,
				]),
			),
		[scopes, i18n.locale],
	)

	const path = ready
		? `/today${scopeId === 'all' ? '' : `?scopeId=${encodeURIComponent(scopeId)}`}`
		: null
	const query = useStaffQuery(client, path, todayResponseSchema)
	useVisiblePolling(query.reload, POLL_MS)

	// Durations count from the server's clock so a wrong device clock cannot
	// show negative or inflated times.
	const data = query.data
	const [receivedAt, setReceivedAt] = useState<{
		serverNow: number
		at: number
	}>()
	if (data && receivedAt?.serverNow !== data.serverNow) {
		setReceivedAt({ serverNow: data.serverNow, at: Date.now() })
	}
	const offset = receivedAt ? receivedAt.serverNow - receivedAt.at : 0
	const now = useLiveNow(30_000, offset)

	const rows = useMemo(() => sortTodayRows(data?.present ?? []), [data])
	const visible = useMemo(() => filterTodayRows(rows, filter), [rows, filter])
	const summary = summarizeToday(rows)
	const showScope = scopes.length > 1

	const reload = query.reload
	const updated = receivedAt
		? formatRelativeTime(receivedAt.at, now - offset, i18n.locale)
		: null

	if (unavailable) {
		return (
			<Alert variant="destructive">
				<AlertDescription>
					<Trans>We could not confirm your access. Reload the page.</Trans>
				</AlertDescription>
			</Alert>
		)
	}

	const scopeOptions = [
		{ value: 'all', label: _(t`All workplaces`) },
		...scopes.map((scope) => ({
			value: scope.id,
			label: scopeNames.get(scope.id) ?? scope.name,
		})),
	]
	const filterLabels: Record<TodayFilter, string> = {
		all: _(t`Everyone`),
		in: _(t`Working`),
		on_break: _(t`On break`),
		attention: _(t`Needs attention`),
	}

	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<div className="flex flex-wrap items-center gap-3">
					{showScope ? (
						<FilterSelect
							label={_(t`Workplace`)}
							options={scopeOptions}
							value={scopeId}
							onValueChange={setScopeId}
						/>
					) : null}
					<ToggleGroup
						aria-label={_(t`Show`)}
						value={[filter]}
						onValueChange={(next) => {
							const picked = next[0] as TodayFilter | undefined
							if (picked && TODAY_FILTERS.includes(picked)) setFilter(picked)
						}}
						variant="segmented"
						className="flex-wrap"
					>
						{TODAY_FILTERS.map((value) => (
							<ToggleGroupItem
								className="h-11 md:h-7"
								key={value}
								value={value}
							>
								{filterLabels[value]}
							</ToggleGroupItem>
						))}
					</ToggleGroup>
				</div>
				<div className="text-muted-foreground flex items-center gap-2 text-xs">
					{data && updated ? (
						<span>
							<Trans>Updated {updated}</Trans>
						</span>
					) : null}
					<Button
						type="button"
						variant="ghost"
						onClick={reload}
						disabled={query.refreshing}
						aria-label={_(t`Refresh`)}
					>
						{query.refreshing ? (
							<Spinner role="presentation" aria-hidden="true" />
						) : (
							<Icon name="refresh-cw" />
						)}
					</Button>
				</div>
			</div>

			<p
				aria-live="polite"
				className={cn('text-sm', data && summary.total === 0 && 'sr-only')}
			>
				{data ? (
					summary.total === 0 ? (
						<span className="text-muted-foreground">
							<Trans>Nobody is clocked in right now.</Trans>
						</span>
					) : (
						<span>
							{plural(summary.total, {
								one: '# person on the clock',
								other: '# people on the clock',
							})}
							{summary.onBreak > 0
								? ` · ${plural(summary.onBreak, { one: '# on break', other: '# on break' })}`
								: ''}
							{summary.attention > 0
								? ` · ${plural(summary.attention, { one: '# needs attention', other: '# need attention' })}`
								: ''}
						</span>
					)
				) : (
					<span className="sr-only">
						<Trans>Loading today</Trans>
					</span>
				)}
			</p>

			{!ready || query.loading ? (
				<div role="status" className="flex flex-col gap-3">
					<span className="sr-only">
						<Trans>Loading who is on the clock</Trans>
					</span>
					<Skeleton className="h-14 w-full" />
					<Skeleton className="h-14 w-full" />
					<Skeleton className="h-14 w-full" />
				</div>
			) : query.error && !data ? (
				<Alert variant="destructive">
					<AlertDescription>
						{describeStaffError(query.error, _)}
					</AlertDescription>
					<Button
						className="mt-2 justify-self-start"
						variant="outline"
						onClick={reload}
					>
						<Trans>Try again</Trans>
					</Button>
				</Alert>
			) : rows.length === 0 ? (
				<EmptyState
					title={
						<>
							<Trans>No one is on the clock</Trans>
						</>
					}
					description={
						<>
							<Trans>
								People show up here the moment they punch in on a paired tablet.
							</Trans>
						</>
					}
					icons={['clock', 'users', 'calendar']}
				>
					{canManageTablets ? (
						<>
							<Button
								variant="outline"
								render={<Link to={`/${orgSlug}/staff/timeclock/tablets`} />}
							>
								<Icon name="tablet" />
								<Trans>Set up a tablet</Trans>
							</Button>
						</>
					) : null}
				</EmptyState>
			) : visible.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					<Trans>No one matches this view.</Trans>
				</p>
			) : (
				<ItemGroup>
					{visible.map((row) => (
						<PresentRow
							key={row.entryId}
							row={row}
							now={now}
							locale={i18n.locale}
							scopeName={showScope ? scopeNames.get(row.scopeId) : undefined}
						/>
					))}
				</ItemGroup>
			)}

			{data && data.recent.length > 0 ? (
				<RecentList
					rows={data.recent}
					locale={i18n.locale}
					scopeNames={showScope ? scopeNames : null}
				/>
			) : null}
		</div>
	)
}

function PresentRow({
	row,
	now,
	locale,
	scopeName,
}: {
	row: TodayRow
	now: number
	locale: string
	scopeName?: string
}) {
	const { _ } = useLingui()
	const name = `${row.firstName} ${row.lastName}`.trim()
	const position = locale.startsWith('ar')
		? (row.positionNameAr ?? row.positionName)
		: row.positionName
	const minutes = minutesBetween(row.clockInAt, now)
	const units = { hour: _(t`h`), minute: _(t`m`) }
	const since = formatClockDateTime(row.clockInAt, now, row.timeZone, locale)
	const elapsed = formatDuration(minutes, units)
	return (
		<Item variant="outline" render={<li />}>
			<div className="flex min-h-14 w-full flex-wrap items-center gap-x-4 gap-y-2">
				<StaffAvatar name={name} />
				<div className="flex min-w-0 flex-1 flex-col">
					<span className="truncate text-sm font-medium">{name}</span>
					<span className="text-muted-foreground truncate text-xs">
						{[position, scopeName].filter(Boolean).join(' · ') || ' '}
					</span>
				</div>
				<div className="flex flex-wrap items-center justify-end gap-2">
					{row.missingClockOut ? (
						<Badge variant="destructive">
							<Trans>Missing clock-out</Trans>
						</Badge>
					) : null}
					{row.late ? (
						<Badge variant="secondary">
							<Trans>Late</Trans>
						</Badge>
					) : null}
					{row.state === 'on_break' ? (
						<Badge variant="outline">
							<Icon name="clock" />
							<Trans>On break</Trans>
						</Badge>
					) : null}
					<span className="text-muted-foreground min-w-24 text-end text-sm tabular-nums">
						<Trans>
							Since {since} · {elapsed}
						</Trans>
					</span>
				</div>
			</div>
		</Item>
	)
}

function RecentList({
	rows,
	locale,
	scopeNames,
}: {
	rows: readonly TodayRecentRow[]
	locale: string
	scopeNames: Map<string, string> | null
}) {
	return (
		<section aria-labelledby="timeclock-recent" className="flex flex-col gap-3">
			<h2 id="timeclock-recent" className="text-sm font-medium">
				<Trans>Clocked out in the last 12 hours</Trans>
			</h2>
			<ItemGroup>
				{rows.map((row) => {
					const name = `${row.firstName} ${row.lastName}`.trim()
					const from = formatClockTime(row.clockInAt, row.timeZone, locale)
					const to = formatClockTime(row.clockOutAt, row.timeZone, locale)
					const place = scopeNames?.get(row.scopeId)
					return (
						<Item key={row.entryId} variant="outline" render={<li />}>
							<div className="flex min-h-12 w-full flex-wrap items-center gap-x-4 gap-y-1">
								<span className="min-w-0 flex-1 truncate text-sm">
									{name}
									{place ? (
										<span className="text-muted-foreground"> · {place}</span>
									) : null}
								</span>
								{row.needsReview ? (
									<Badge variant="secondary">
										<Trans>Needs review</Trans>
									</Badge>
								) : null}
								<span className="text-muted-foreground text-sm tabular-nums">
									{from} – {to}
								</span>
							</div>
						</Item>
					)
				})}
			</ItemGroup>
		</section>
	)
}
