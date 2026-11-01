import { Trans, useLingui } from '@lingui/react/macro'
import { db, eq, OrganizationLocation } from '@repo/database'
import { type DiscountUsageEntry } from '@repo/discounts'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Frame } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { PageHeader } from '@repo/ui/page-header'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { WorkspacePage } from '@repo/ui/workspace'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	Link,
	useFetcher,
	useLoaderData,
	useSearchParams,
} from 'react-router'
import { ArchiveDiscountButton } from '#app/components/discounts/archive-discount-button.tsx'
import { LimitNotice } from '#app/components/discounts/fields.tsx'
import { EmptyState } from '#app/components/empty-state.tsx'
import { requireDiscountsAccess } from '#app/utils/discounts/access.server.ts'
import {
	type DiscountListEntry,
	listDiscounts,
} from '#app/utils/discounts/discounts.server.ts'
import {
	DISCOUNT_APPLICATION_LABELS,
	DISCOUNT_DISPLAY_STATE_LABELS,
	DISCOUNT_ELIGIBILITY_LABELS,
	type DiscountDisplayState,
	type Translate,
	amountEach,
	appliesSummary,
	discountDisplayState,
	formatMoney,
	listText,
	localNowText,
	numberText,
	perCustomerSummary,
	valueSummary,
	whenSummary,
	zonedNowText,
} from '#app/utils/discounts/labels.ts'
import { type DiscountLimit } from '#app/utils/discounts/limits.ts'
import {
	discountEditableInScope,
	discountVisibleInScope,
} from '#app/utils/discounts/location-scope.server.ts'
import { saveDiscountEditor } from '#app/utils/discounts/save.server.ts'
import { createDiscountUsageClient } from '#app/utils/discounts/usage-client.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requireDiscountsAccess(request, params.orgSlug)
	const [listed, locations] = await Promise.all([
		listDiscounts(access.organization.id),
		// A discount's dates are local times in each location's own zone, so the
		// list needs the zones to say Scheduled or Ended correctly.
		db
			.select({
				id: OrganizationLocation.id,
				timezone: OrganizationLocation.timezone,
			})
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.organizationId, access.organization.id)),
	])
	// A row that no longer parses has no location list to check: `undefined`
	// shows it only to members with every location (it fails closed). A
	// discount shared with locations outside the member's own is read-only.
	const discounts = listed.flatMap((entry) => {
		const locationIds = entry.definition
			? entry.definition.locationIds
			: undefined
		if (!discountVisibleInScope(locationIds, access.locationIds)) return []
		return [
			{
				...entry,
				editable: discountEditableInScope(locationIds, access.locationIds),
			},
		]
	})
	return {
		orgSlug: access.organization.slug,
		currency: access.currency,
		canWrite: access.canWrite,
		discounts,
		locationZones: Object.fromEntries(
			locations.map((location) => [location.id, location.timezone]),
		),
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const access = await requireDiscountsAccess(request, params.orgSlug, {
		write: true,
	})
	return saveDiscountEditor({ request, params, access })
}

const STATUS_FILTERS = [
	'current',
	'active',
	'paused',
	'archived',
	'all',
] as const
const KIND_FILTERS = ['all', 'automatic', 'code', 'manual'] as const

export default function DiscountsIndexRoute() {
	const { orgSlug, currency, canWrite, discounts, locationZones } =
		useLoaderData<typeof loader>()
	const { t, i18n } = useLingui()
	const [params, setParams] = useSearchParams()
	const statusFilter =
		STATUS_FILTERS.find((value) => value === params.get('status')) ?? 'current'
	const kindFilter =
		KIND_FILTERS.find((value) => value === params.get('kind')) ?? 'all'
	const usageFrom = params.get('from') ?? ''
	const usageTo = params.get('to') ?? ''
	const visible = discounts.filter((discount) => {
		if (kindFilter !== 'all' && discount.application !== kindFilter)
			return false
		if (statusFilter === 'current') return discount.status !== 'archived'
		if (statusFilter === 'all') return true
		return discount.status === statusFilter
	})
	const ids = useMemo(
		() => discounts.map((discount) => discount.id),
		[discounts],
	)
	const [usage, setUsage] = useState<Record<string, DiscountUsageEntry> | null>(
		null,
	)
	const [usageFailed, setUsageFailed] = useState(false)
	// The clock decides Scheduled and Ended, read in each discount's location
	// zones. It is read after the page opens, so the server and the browser draw
	// the same first frame.
	const [now, setNow] = useState<Date | null>(null)
	useEffect(() => {
		setNow(new Date())
	}, [])
	const allZones = useMemo(
		() => [...new Set(Object.values(locationZones))],
		[locationZones],
	)
	// A count for a date range says nothing about a lifetime limit.
	const dateRange = Boolean(usageFrom || usageTo)

	useEffect(() => {
		const client = createDiscountUsageClient({ orgSlug })
		const controller = new AbortController()
		void client
			.fetchUsage(ids, controller.signal, {
				from: usageFrom || undefined,
				to: usageTo || undefined,
			})
			.then((result) => {
				if (controller.signal.aborted) return
				setUsage(result)
				setUsageFailed(result === null)
			})
		return () => controller.abort()
	}, [orgSlug, ids, usageFrom, usageTo])

	const isShown = (discount: { application: string; status: string }) => {
		if (kindFilter !== 'all' && discount.application !== kindFilter) {
			return false
		}
		if (statusFilter === 'current') return discount.status !== 'archived'
		if (statusFilter === 'all') return true
		return discount.status === statusFilter
	}
	// A status change can take the row off this list (Archive always does).
	// Focus would fall to the page, so it moves to a neighbour, and a polite
	// status line says what happened.
	const [announcement, setAnnouncement] = useState('')
	// A restore the region refused because the organization is at a cap. It is
	// the page's message, not one row's, so it sits under the header.
	const [limit, setLimit] = useState<DiscountLimit | null>(null)
	const pending = useRef<{
		id: string
		name: string
		from: string
		status: string
		neighbour: string | null
	} | null>(null)
	function statusRequested(
		discount: { id: string; name: string; status: string },
		status: string,
	) {
		setLimit(null)
		const index = visible.findIndex((entry) => entry.id === discount.id)
		const neighbour = visible[index + 1] ?? visible[index - 1] ?? null
		pending.current = {
			id: discount.id,
			name: discount.name,
			from: discount.status,
			status,
			neighbour: neighbour?.id ?? null,
		}
	}
	useEffect(() => {
		const request = pending.current
		if (!request) return
		const saved = discounts.find((discount) => discount.id === request.id)
		// The list reloads after every action. A refused one leaves the status as
		// it was, so there is nothing to say or move.
		if (!saved || saved.status !== request.status) {
			pending.current = null
			return
		}
		pending.current = null
		const { name } = request
		setAnnouncement(
			request.status === 'archived'
				? t`${name} archived.`
				: request.status === 'active'
					? t`${name} resumed.`
					: request.from === 'archived'
						? t`${name} restored. It is paused.`
						: t`${name} paused.`,
		)
		const target = isShown(saved) ? saved.id : (request.neighbour ?? null)
		const node =
			(target ? document.getElementById(`discount-link-${target}`) : null) ??
			document.getElementById('discount-status-filter')
		node?.focus()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [discounts])

	function setFilter(key: 'status' | 'kind' | 'from' | 'to', value: string) {
		const next = new URLSearchParams(params)
		if (
			(key === 'status' && value === 'current') ||
			(key === 'kind' && value === 'all') ||
			((key === 'from' || key === 'to') && !value)
		) {
			next.delete(key)
		} else {
			next.set(key, value)
		}
		setParams(next, { replace: true })
	}

	return (
		<WorkspacePage>
			<PageHeader
				title={<Trans>Discounts</Trans>}
				description={
					<Trans>
						Automatic discounts and coupon codes. Loyalty rewards apply after
						these, on what is left.
					</Trans>
				}
				actions={
					canWrite ? (
						<Button render={<Link to={`/${orgSlug}/discounts/new`} />}>
							<Icon name="plus" className="size-4" />
							<Trans>New discount</Trans>
						</Button>
					) : null
				}
			/>

			{limit ? <LimitNotice limit={limit} /> : null}

			{discounts.length === 0 ? (
				<EmptyState
					title={t`No discounts yet`}
					description={t`Create an automatic discount or a coupon code. Customers see it at checkout when their order qualifies.`}
					icons={['tag', 'receipt', 'sparkles']}
					action={
						canWrite
							? {
									label: t`New discount`,
									href: `/${orgSlug}/discounts/new`,
								}
							: undefined
					}
				/>
			) : (
				<>
					<div className="flex flex-wrap items-end gap-3">
						<FilterSelect
							id="discount-kind-filter"
							label={t`Type`}
							value={kindFilter}
							onChange={(value) => setFilter('kind', value)}
							options={[
								{ value: 'all', label: t`All types` },
								{ value: 'automatic', label: t`Automatic` },
								{ value: 'code', label: t`Coupon codes` },
								{ value: 'manual', label: t`At the till` },
							]}
						/>
						<label
							className="flex flex-col gap-1 text-sm"
							htmlFor="discount-usage-from"
						>
							<span className="text-muted-foreground">{t`Uses from`}</span>
							<input
								id="discount-usage-from"
								type="date"
								className="border-input bg-background h-9 rounded-md border px-2"
								value={usageFrom}
								onChange={(event) =>
									setFilter('from', event.currentTarget.value)
								}
							/>
						</label>
						<label
							className="flex flex-col gap-1 text-sm"
							htmlFor="discount-usage-to"
						>
							<span className="text-muted-foreground">{t`Uses to`}</span>
							<input
								id="discount-usage-to"
								type="date"
								className="border-input bg-background h-9 rounded-md border px-2"
								value={usageTo}
								onChange={(event) => setFilter('to', event.currentTarget.value)}
							/>
						</label>
						<FilterSelect
							id="discount-status-filter"
							label={t`Status`}
							value={statusFilter}
							onChange={(value) => setFilter('status', value)}
							options={[
								{ value: 'current', label: t`Active and paused` },
								{ value: 'active', label: t`Active` },
								{ value: 'paused', label: t`Paused` },
								{ value: 'archived', label: t`Archived` },
								{ value: 'all', label: t`All statuses` },
							]}
						/>
						{usageFailed ? (
							<p role="status" className="text-muted-foreground text-sm">
								<Trans>Usage counts are unavailable right now.</Trans>
							</p>
						) : null}
					</div>
					<p role="status" className="sr-only">
						{announcement}
					</p>
					{visible.length === 0 ? (
						<EmptyState
							title={t`No discounts match these filters`}
							description={t`Try another type or status.`}
							icons={['search']}
						/>
					) : (
						<Frame className="w-full">
							<Table variant="card">
								<TableHeader>
									<TableRow>
										<TableHead>
											<Trans>Discount</Trans>
										</TableHead>
										<TableHead>
											<Trans>Status</Trans>
										</TableHead>
										<TableHead className="hidden md:table-cell">
											<Trans>Uses</Trans>
										</TableHead>
										<TableHead className="w-36">
											<span className="sr-only">
												<Trans>Actions</Trans>
											</span>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{visible.map((discount) => (
										<DiscountRow
											key={discount.id}
											discount={discount}
											orgSlug={orgSlug}
											currency={currency}
											locale={i18n.locale}
											canWrite={canWrite}
											usage={usage?.[discount.id] ?? null}
											usageReady={usage !== null}
											now={now}
											allZones={allZones}
											locationZones={locationZones}
											dateRange={dateRange}
											onStatusRequested={statusRequested}
											onLimit={setLimit}
										/>
									))}
								</TableBody>
							</Table>
						</Frame>
					)}
				</>
			)}
		</WorkspacePage>
	)
}

type DiscountRowEntry = DiscountListEntry & {
	/** False when the discount also runs at locations outside the member's. */
	editable: boolean
}

function DiscountRow({
	discount,
	orgSlug,
	currency,
	locale,
	canWrite,
	usage,
	usageReady,
	now,
	allZones,
	locationZones,
	dateRange,
	onStatusRequested,
	onLimit,
}: {
	discount: DiscountRowEntry
	orgSlug: string
	currency: string
	locale: string
	canWrite: boolean
	usage: DiscountUsageEntry | null
	usageReady: boolean
	now: Date | null
	allZones: readonly string[]
	locationZones: Record<string, string>
	dateRange: boolean
	onStatusRequested: (
		discount: { id: string; name: string; status: string },
		status: string,
	) => void
	onLimit: (limit: DiscountLimit) => void
}) {
	const { t, i18n } = useLingui()
	const fetcher = useFetcher<typeof action>()
	const refusedLimit =
		fetcher.data && 'limit' in fetcher.data ? fetcher.data.limit : undefined
	useEffect(() => {
		if (refusedLimit) onLimit(refusedLimit)
		// `onLimit` is a state setter.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [fetcher.data])
	const href = `/${orgSlug}/discounts/${discount.id}`
	const definition = discount.definition
	const status = discount.status
	const nextStatus =
		status === 'active' ? 'paused' : status === 'paused' ? 'active' : 'paused'
	const name = discount.name
	const nextLabel =
		status === 'active' ? (
			<Trans>Pause</Trans>
		) : status === 'archived' ? (
			<Trans>Restore</Trans>
		) : (
			<Trans>Resume</Trans>
		)
	// Every row has these buttons, so each one names its discount.
	const nextAriaLabel =
		status === 'active'
			? t`Pause ${name}`
			: status === 'archived'
				? t`Restore ${name}`
				: t`Resume ${name}`
	const tx: Translate = (descriptor) => i18n._(descriptor)
	const value = definition
		? valueSummary(
				definition,
				tx,
				locale,
				currency,
				amountEach(definition.target.scope, definition.quantityRule.kind),
			)
		: null
	const when = definition ? whenSummary(definition, tx, locale) : null
	const who =
		definition && definition.eligibility !== 'everyone'
			? i18n._(DISCOUNT_ELIGIBILITY_LABELS[definition.eligibility])
			: null
	const perCustomer = definition?.perCustomerLimit
		? perCustomerSummary(definition.perCustomerLimit, tx)
		: null
	const applies = definition
		? appliesSummary(definition, (descriptor) => i18n._(descriptor))
		: null
	const limit = definition?.totalLimit
	// Dates are local times in the zones of the locations the discount runs at.
	const zones = definition?.locationIds
		? [
				...new Set(
					definition.locationIds.flatMap((id) => locationZones[id] ?? []),
				),
			]
		: allZones
	const clocks = now
		? zones.flatMap((zone) => zonedNowText(now, zone) ?? [])
		: []
	const nowLocal = now
		? clocks.length > 0
			? clocks
			: // No location zone to read: the browser's own clock is the best guess.
				localNowText(now)
		: null
	const displayState = discountDisplayState(
		{
			status,
			startsAt: definition?.startsAt ?? null,
			endsAt: definition?.endsAt ?? null,
			totalLimit: limit ?? null,
			uses: usageReady && !dateRange ? (usage?.uses ?? 0) : null,
		},
		nowLocal,
	)
	const code = discount.codes[0]?.code

	return (
		<TableRow>
			<TableCell>
				<Link
					id={`discount-link-${discount.id}`}
					to={href}
					className="font-medium underline-offset-4 hover:underline"
				>
					{discount.name}
				</Link>
				<p className="text-muted-foreground mt-0.5 text-sm">
					{definition ? (
						listText(
							[
								i18n._(DISCOUNT_APPLICATION_LABELS[definition.application]),
								value,
								applies,
								code
									? `${code}${discount.codes.length > 1 ? ` +${numberText(discount.codes.length - 1, locale)}` : ''}`
									: null,
							].filter((part): part is string => Boolean(part)),
							locale,
						)
					) : (
						<Trans>This discount needs a fix before it can apply.</Trans>
					)}
				</p>
				{when ? (
					<p className="text-muted-foreground text-sm">
						{[when, who, perCustomer]
							.filter((part): part is string => Boolean(part))
							// A dot between phrases that hold commas of their own.
							.join(' · ')}
					</p>
				) : null}
			</TableCell>
			<TableCell>
				<StatusBadge status={displayState} />
			</TableCell>
			<TableCell className="hidden tabular-nums md:table-cell">
				{!usageReady ? (
					<span className="text-muted-foreground">—</span>
				) : (
					<span>
						{numberText(usage?.uses ?? 0, locale)}
						{!dateRange && limit !== null && limit !== undefined
							? ` / ${numberText(limit, locale)}`
							: ''}
						{usage && usage.discountMinor > 0 ? (
							<span className="text-muted-foreground">
								{' '}
								· {formatMoney(usage.discountMinor, currency, locale)}
							</span>
						) : null}
					</span>
				)}
			</TableCell>
			<TableCell>
				{canWrite && !discount.editable ? (
					<p className="text-muted-foreground text-end text-xs">
						<Trans>Shared with other locations. View only.</Trans>
					</p>
				) : null}
				{canWrite && discount.editable ? (
					<fetcher.Form
						method="post"
						className="flex flex-col items-end gap-1"
						onSubmit={() => onStatusRequested(discount, nextStatus)}
					>
						{fetcher.data &&
						'noCodes' in fetcher.data &&
						fetcher.data.noCodes ? (
							<p role="alert" className="text-destructive text-xs">
								<Trans>Add a code before turning this discount on.</Trans>
							</p>
						) : null}
						{fetcher.data && 'stale' in fetcher.data && fetcher.data.stale ? (
							<p role="alert" className="text-destructive text-xs">
								<Trans>Reload the page, then try again.</Trans>
							</p>
						) : null}
						{fetcher.data && 'scope' in fetcher.data && fetcher.data.scope ? (
							<p role="alert" className="text-destructive text-xs">
								<Trans>
									It now also runs at locations outside yours, so you can't
									change it.
								</Trans>
							</p>
						) : null}
						<div className="flex justify-end gap-2">
							<input type="hidden" name="intent" value="set-status" />
							<input type="hidden" name="discountId" value={discount.id} />
							<input
								type="hidden"
								name="expectedVersion"
								value={String(discount.version)}
							/>
							<Button
								type="submit"
								name="status"
								value={nextStatus}
								variant="outline"
								size="sm"
								aria-label={nextAriaLabel}
								disabled={fetcher.state !== 'idle'}
							>
								{nextLabel}
							</Button>
							{status !== 'archived' ? (
								<ArchiveDiscountButton
									name={discount.name}
									hasCodes={discount.application === 'code'}
									disabled={fetcher.state !== 'idle'}
									onConfirm={() => {
										onStatusRequested(discount, 'archived')
										void fetcher.submit(
											{
												intent: 'set-status',
												discountId: discount.id,
												expectedVersion: String(discount.version),
												status: 'archived',
											},
											{ method: 'post' },
										)
									}}
								/>
							) : null}
						</div>
					</fetcher.Form>
				) : null}
			</TableCell>
		</TableRow>
	)
}

const STATE_VARIANTS = {
	active: 'success',
	paused: 'warning',
	archived: 'secondary',
	scheduled: 'default',
	ended: 'secondary',
	limit_reached: 'warning',
} as const

function StatusBadge({ status }: { status: DiscountDisplayState | string }) {
	const { i18n } = useLingui()
	if (Object.hasOwn(STATE_VARIANTS, status)) {
		const known = status as DiscountDisplayState
		return (
			<Badge variant={STATE_VARIANTS[known]}>
				{i18n._(DISCOUNT_DISPLAY_STATE_LABELS[known])}
			</Badge>
		)
	}
	return <Badge variant="secondary">{status}</Badge>
}

function FilterSelect({
	id,
	label,
	value,
	onChange,
	options,
}: {
	id: string
	label: string
	value: string
	onChange: (value: string) => void
	options: Array<{ value: string; label: string }>
}) {
	return (
		<label htmlFor={id} className="flex flex-col gap-1 text-sm">
			<span className="font-medium">{label}</span>
			<select
				id={id}
				className="border-input bg-card h-8 min-w-40 rounded-md border px-2.5"
				value={value}
				onChange={(event) => onChange(event.currentTarget.value)}
			>
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		</label>
	)
}
