import { msg, plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/popover'
import { useMemo } from 'react'
import { type DayTotals } from './book.ts'
import { type DayService } from './feed.ts'
import { addDays } from './zoned.ts'
import {
	Button,
	cn,
	IconButton,
	NumberPop,
	Segmented,
	Select,
} from '~/ui/primitives.tsx'

/**
 * A control that sends a change to the server: while the connection is down it
 * is shown as unavailable (aria-disabled, with the reason as its title) and does
 * nothing, instead of failing after the tap.
 */
export function whenOnline(
	onClick: () => void,
	offlineReason: string | null | undefined,
) {
	return offlineReason
		? ({
				'aria-disabled': true,
				title: offlineReason,
				className: 'cursor-not-allowed opacity-45',
			} as const)
		: { onClick }
}

export type MainView = 'list' | 'floor' | 'timeline'
export type PaneTab = 'list' | 'floor' | 'timeline'

/**
 * A small segmented control that can leave an option out of reach (the floor
 * is today's: on another day it is greyed, not removed). The pill slides to the
 * chosen option with a transform; arrow keys move between options.
 */
export function ViewTabs<T extends string>({
	label,
	value,
	onChange,
	options,
	className,
}: {
	label: string
	value: T
	onChange: (value: T) => void
	options: Array<{
		value: T
		label: string
		icon?: React.ReactNode
		disabled?: boolean
		/** Hide the words below the `2xl` width (the icon stays, the name is still read). */
		compact?: boolean
	}>
	className?: string
}) {
	const index = Math.max(
		0,
		options.findIndex((option) => option.value === value),
	)
	return (
		<div
			role="radiogroup"
			aria-label={label}
			className={cn(
				'bk-tabs bg-muted relative isolate grid gap-0 rounded-(--station-group-radius) px-1',
				className,
			)}
			style={{ '--n': options.length, '--i': index } as React.CSSProperties}
			onKeyDown={(event) => {
				if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
					return
				event.preventDefault()
				const rtl = getComputedStyle(event.currentTarget).direction === 'rtl'
				const step = (event.key === 'ArrowRight') !== rtl ? 1 : -1
				const usable = options.filter((option) => !option.disabled)
				const at = usable.findIndex((option) => option.value === value)
				const next =
					event.key === 'Home'
						? usable[0]
						: event.key === 'End'
							? usable.at(-1)
							: usable[(at + step + usable.length) % usable.length]
				if (next) {
					onChange(next.value)
					const radios =
						event.currentTarget.querySelectorAll<HTMLButtonElement>(
							'[role="radio"]',
						)
					radios[options.indexOf(next)]?.focus()
				}
			}}
		>
			<span
				aria-hidden
				className="bk-tabs-pill absolute inset-y-1 start-1 z-0 rounded-(--station-control-radius)"
			/>
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					role="radio"
					aria-checked={option.value === value}
					aria-disabled={option.disabled || undefined}
					tabIndex={option.value === value ? 0 : -1}
					onClick={() => !option.disabled && onChange(option.value)}
					title={option.label}
					className="bk-tab relative z-1 inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-(--station-control-radius) px-3 text-sm font-medium whitespace-nowrap"
				>
					{option.icon}
					<span className={cn(option.compact && 'max-2xl:sr-only')}>
						{option.label}
					</span>
				</button>
			))}
		</div>
	)
}

/**
 * What the day holds: parties and covers, and (today) how many are still to
 * seat and how many are seated. Stacked in the header's corner, or on one line
 * in a toolbar or on a phone.
 */
export function StandStats({
	totals,
	filtered,
	serviceName,
	isToday,
	inline = false,
	className,
}: {
	totals: DayTotals
	/** A service narrows the totals: say so. */
	filtered: boolean
	serviceName?: string | null
	isToday: boolean
	inline?: boolean
	className?: string
}) {
	const { _ } = useLingui()
	const parties = _(
		plural(totals.parties, { one: '# party', other: '# parties' }),
	)
	const covers = _(plural(totals.covers, { one: '# cover', other: '# covers' }))
	return (
		<div
			className={cn(
				'min-w-0',
				inline && 'flex flex-wrap items-baseline gap-x-2',
				className,
			)}
		>
			<p
				className={cn(
					'leading-snug font-semibold',
					inline ? 'text-sm' : 'text-base',
				)}
			>
				<NumberPop value={parties} className="tnum text-foreground" />
				{' · '}
				<NumberPop value={covers} className="tnum text-foreground" />
			</p>
			<p className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 text-sm leading-snug">
				{isToday ? (
					<span>
						<Trans>
							<NumberPop
								value={String(totals.toSeat)}
								className="tnum text-foreground font-semibold"
							/>{' '}
							to seat ·{' '}
							<NumberPop
								value={String(totals.seated)}
								className="tnum text-foreground font-semibold"
							/>{' '}
							seated
						</Trans>
					</span>
				) : (
					<span>
						<Trans>Read only, seating is for today</Trans>
					</span>
				)}
				{filtered && serviceName ? (
					<span className="bg-muted rounded-full px-2 text-xs font-semibold">
						{serviceName}
					</span>
				) : null}
			</p>
		</div>
	)
}

/**
 * The day in one short line for the header: covers, and (today) how many are
 * still to seat. Parties and seated counts are in its title and in the list.
 */
export function HeaderStats({
	totals,
	isToday,
}: {
	totals: DayTotals
	isToday: boolean
}) {
	const { _ } = useLingui()
	const parties = _(
		plural(totals.parties, { one: '# party', other: '# parties' }),
	)
	const covers = _(plural(totals.covers, { one: '# cover', other: '# covers' }))
	const waiting = totals.toSeat
	const toSeat = _(plural(waiting, { one: '# to seat', other: '# to seat' }))
	return (
		<p
			className="inline-flex min-w-0 items-center gap-1.5 text-sm whitespace-nowrap"
			title={`${parties} · ${covers}`}
		>
			<Icon name="users" aria-hidden className="text-muted-foreground size-4" />
			<NumberPop value={covers} className="tnum font-semibold" />
			{isToday ? (
				<>
					<span aria-hidden className="text-muted-foreground">
						·
					</span>
					<NumberPop value={toSeat} className="tnum text-muted-foreground" />
				</>
			) : null}
		</p>
	)
}

/**
 * The host stand's context in the shared app header: day, service and adds.
 * The pane toolbar owns Floor | Timeline and the day's figures; a phone puts
 * its adds in the bottom dock instead.
 */
export function StandHeader({
	totals,
	filtered,
	date,
	isToday,
	today,
	onDate,
	services,
	serviceId,
	onService,
	wide,
	waitlistOn,
	stale,
	onWalkIn,
	onWaitlist,
	onBooking,
	offlineReason = null,
	view = null,
}: {
	totals: DayTotals
	/** A service narrows the totals: say so. */
	filtered: boolean
	/**
	 * The day asked for: the arrows move from here, so quick taps keep moving
	 * while a day is still loading (the screen may still be drawn for the day before).
	 */
	date: string
	isToday: boolean
	today: string
	onDate: (date: string | null) => void
	services: DayService[]
	serviceId: string | null
	onService: (id: string | null) => void
	/** Two panes: show adds here; a phone uses the bottom dock. */
	wide: boolean
	waitlistOn: boolean
	stale: boolean
	onWalkIn: () => void
	onWaitlist: () => void
	onBooking: () => void
	/** The connection is down: the three adds wait for it (and say so). */
	offlineReason?: string | null
	/** Floor | Timeline, beside the adds on a wide screen. */
	view?: React.ReactNode
}) {
	const { _, i18n } = useLingui()
	const shortLabel = useMemo(() => {
		// A phone has no room for the month: "Sun 25" (built from parts: en-US alone would say "25 Sun").
		const parts = new Intl.DateTimeFormat(i18n.locale, {
			weekday: 'short',
			day: 'numeric',
			timeZone: 'UTC',
		}).formatToParts(new Date(`${date}T12:00:00Z`))
		const part = (type: Intl.DateTimeFormatPartTypes) =>
			parts.find((p) => p.type === type)?.value ?? ''
		return `${part('weekday')} ${part('day')}`
	}, [date, i18n.locale])
	const label = useMemo(() => {
		const format = new Intl.DateTimeFormat(i18n.locale, {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			timeZone: 'UTC',
		})
		return format.format(new Date(`${date}T12:00:00Z`))
	}, [date, i18n.locale])
	const go = (days: number) => {
		const next = addDays(date, days)
		onDate(next === today ? null : next)
	}
	const serviceName = serviceId
		? services.find((s) => s.id === serviceId)?.name
		: null
	const stats = (
		<StandStats
			totals={totals}
			filtered={filtered}
			serviceName={serviceName}
			isToday={isToday}
			inline={!wide}
		/>
	)

	return (
		<div
			className="bk-header min-w-0 shrink-0 flex-wrap gap-x-3"
			role="group"
			data-wide={wide}
			aria-label={_(msg`Today’s book`)}
		>
			<div className="bk-datebar flex shrink-0 items-center gap-1.5">
				<IconButton label={_(msg`Previous day`)} onClick={() => go(-1)}>
					<Icon name="chevron-left" className="size-5 rtl:rotate-180" />
				</IconButton>
				<label className="bk-date relative inline-flex items-center justify-center gap-2 rounded-(--station-control-radius) border-0 text-sm font-semibold">
					<span className="bk-date-long tnum" aria-hidden>
						{label}
					</span>
					<span className="bk-date-short tnum" aria-hidden>
						{shortLabel}
					</span>
					<input
						type="date"
						value={date}
						onChange={(event) => {
							const picked = event.target.value
							if (picked) onDate(picked === today ? null : picked)
						}}
						aria-label={_(msg`Choose the day, now ${label}`)}
					/>
				</label>
				<IconButton label={_(msg`Next day`)} onClick={() => go(1)}>
					<Icon name="chevron-right" className="size-5 rtl:rotate-180" />
				</IconButton>
				{wide && !isToday ? (
					<Button variant="ghost" onClick={() => onDate(null)}>
						<Trans>Today</Trans>
					</Button>
				) : null}
			</div>

			<div className="bk-services [scrollbar-width:none] overflow-x-auto">
				{services.length > 0 && !wide ? (
					// A phone has no room for the segments: a plain choice list.
					<Select
						aria-label={_(msg`Service`)}
						value={serviceId ?? ''}
						onChange={(event) => onService(event.target.value || null)}
						className="border-border bg-card h-11 w-full min-w-0 rounded-(--station-control-radius) border px-3 text-base font-semibold sm:text-sm"
					>
						<option value="">{_(msg`All services`)}</option>
						{services.map((s) => (
							<option key={s.id} value={s.id}>
								{s.name}
							</option>
						))}
					</Select>
				) : services.length > 0 ? (
					<Segmented
						label={_(msg`Service`)}
						value={serviceId ?? ''}
						onChange={(value) => onService(value || null)}
						options={[
							{ value: '', label: _(msg`All services`) },
							...services.map((s) => ({ value: s.id, label: s.name })),
						]}
						wrap={false}
					/>
				) : (
					<span className="bg-muted inline-flex min-h-11 items-center rounded-(--station-control-radius) px-4 text-sm font-semibold">
						<Trans>All day</Trans>
					</span>
				)}
			</div>

			{wide ? <HeaderStats totals={totals} isToday={isToday} /> : null}

			{!wide ? (
				<div className="bk-stats-phone">
					{!isToday ? (
						<Button variant="ghost" onClick={() => onDate(null)}>
							<Trans>Today</Trans>
						</Button>
					) : null}
					{stats}
				</div>
			) : null}

			<div className="bk-actions ms-auto flex max-w-full flex-wrap items-center gap-2">
				{/* Always present, so going stale is announced. */}
				<span role="status" className="contents">
					{stale ? (
						<span
							className="text-warning inline-flex items-center gap-1 text-sm font-medium"
							title={_(msg`Not up to date`)}
						>
							<Icon name="cloud-off" className="size-4" />
							<span className="max-xl:sr-only">
								<Trans>Not up to date</Trans>
							</span>
						</span>
					) : null}
				</span>
				{wide ? (
					<>
						{view}
						<Button
							variant="ghost"
							disabled={!isToday}
							aria-label={_(msg`Walk-in`)}
							title={_(msg`Walk-in`)}
							{...whenOnline(onWalkIn, offlineReason)}
						>
							<Icon name="user-plus" className="size-4" />
							<span className="bk-action-label" data-compact>
								<Trans>Walk-in</Trans>
							</span>
						</Button>
						{waitlistOn ? (
							<Button
								variant="ghost"
								disabled={!isToday}
								aria-label={_(msg`Add to the waitlist`)}
								title={_(msg`Add to the waitlist`)}
								{...whenOnline(onWaitlist, offlineReason)}
							>
								<Icon name="list-plus" className="size-4" />
								<span className="bk-action-label" data-compact>
									<Trans>Waitlist</Trans>
								</span>
							</Button>
						) : null}
						<Button
							variant="primary"
							aria-label={_(msg`New booking`)}
							title={_(msg`New booking`)}
							{...whenOnline(onBooking, offlineReason)}
						>
							<Icon name="calendar-plus" className="size-4" />
							<span className="bk-action-label">
								<Trans>Book</Trans>
							</span>
						</Button>
					</>
				) : null}
			</div>
		</div>
	)
}

/** The List | Floor | Timeline tabs of a phone, one pane at a time. */
export function PaneTabs({
	value,
	onChange,
	floorOn,
	listCount,
}: {
	value: PaneTab
	onChange: (value: PaneTab) => void
	floorOn: boolean
	listCount: number
}) {
	const { _ } = useLingui()
	return (
		<div className="border-border bg-card shrink-0 border-b px-3 py-2">
			<ViewTabs
				label={_(msg`Show`)}
				value={value}
				onChange={onChange}
				options={[
					{
						value: 'list',
						label: _(msg`List (${listCount})`),
						icon: <Icon name="list" className="size-4 max-[430px]:hidden" />,
					},
					{
						value: 'floor',
						label: _(msg`Floor`),
						icon: (
							<Icon name="layout-grid" className="size-4 max-[430px]:hidden" />
						),
						disabled: !floorOn,
					},
					{
						value: 'timeline',
						label: _(msg`Timeline`),
						icon: <Icon name="rows-3" className="size-4 max-[430px]:hidden" />,
					},
				]}
			/>
		</div>
	)
}

/**
 * The three things a host does all shift, at the bottom of a phone where a
 * thumb rests: a walk-in, a name on the waitlist, a booking. Each has its own
 * icon and its word; the header above keeps the day and the service.
 */
export function StandDock({
	isToday,
	waitlistOn,
	onWalkIn,
	onWaitlist,
	onBooking,
	dockRef,
	offlineReason = null,
}: {
	isToday: boolean
	waitlistOn: boolean
	onWalkIn: () => void
	onWaitlist: () => void
	onBooking: () => void
	/** The dock itself, so a toast can rise above it instead of covering it. */
	dockRef?: React.Ref<HTMLElement>
	/** The connection is down: the adds wait for it (and say so). */
	offlineReason?: string | null
}) {
	const { _ } = useLingui()
	return (
		<nav
			ref={dockRef}
			aria-label={_(msg`Add to the book`)}
			className="bk-dock border-border bg-card grid shrink-0 gap-2 border-t"
			data-count={waitlistOn ? 3 : 2}
		>
			<Button
				variant="ghost"
				size="lg"
				disabled={!isToday}
				{...whenOnline(onWalkIn, offlineReason)}
				className={cn(
					'h-auto min-h-12 min-w-0 gap-1.5 px-2 py-1.5',
					offlineReason && 'cursor-not-allowed opacity-45',
				)}
			>
				<Icon name="user-plus" aria-hidden className="size-5 shrink-0" />
				<span className="min-w-0 text-center leading-tight">
					<Trans>Walk-in</Trans>
				</span>
			</Button>
			{waitlistOn ? (
				<Button
					variant="ghost"
					size="lg"
					disabled={!isToday}
					aria-label={_(msg`Add to the waitlist`)}
					{...whenOnline(onWaitlist, offlineReason)}
					className={cn(
						'h-auto min-h-12 min-w-0 gap-1.5 px-2 py-1.5',
						offlineReason && 'cursor-not-allowed opacity-45',
					)}
				>
					<Icon name="list-plus" aria-hidden className="size-5 shrink-0" />
					<span className="min-w-0 text-center leading-tight">
						<Trans>Waitlist</Trans>
					</span>
				</Button>
			) : null}
			<Button
				variant="primary"
				size="lg"
				aria-label={_(msg`New booking`)}
				{...whenOnline(onBooking, offlineReason)}
				className={cn(
					'h-auto min-h-12 min-w-0 gap-1.5 px-2 py-1.5',
					offlineReason && 'cursor-not-allowed opacity-45',
				)}
			>
				<Icon name="calendar-plus" aria-hidden className="size-5 shrink-0" />
				<span className="min-w-0 text-center leading-tight">
					<Trans>Book</Trans>
				</span>
			</Button>
		</nav>
	)
}

/**
 * What the table colours mean, one tap away instead of across the toolbar:
 * the floor's states are learnt once and read every minute after.
 */
export function TableLegend() {
	const { _ } = useLingui()
	const states = [
		{ kind: 'open', label: _(msg`Open`) },
		{ kind: 'soon', label: _(msg`Due soon`) },
		{ kind: 'seated', label: _(msg`Seated`) },
		{ kind: 'resetting', label: _(msg`Resetting`) },
		{ kind: 'blocked', label: _(msg`Blocked`) },
	]
	return (
		<Popover>
			<PopoverTrigger
				render={
					<IconButton label={_(msg`Table colours`)} className="ms-auto">
						<Icon name="info" className="size-5" />
					</IconButton>
				}
			/>
			<PopoverContent align="end" className="w-56">
				<ul
					aria-label={_(msg`Table colours`)}
					className="flex flex-col gap-2.5 p-1"
				>
					{states.map((state) => (
						<li key={state.kind} className="flex items-center gap-2.5 text-sm">
							<span
								className="bk-dot inline-block h-2.5 w-2.5 shrink-0"
								data-kind={state.kind}
							/>
							{state.label}
						</li>
					))}
				</ul>
			</PopoverContent>
		</Popover>
	)
}
