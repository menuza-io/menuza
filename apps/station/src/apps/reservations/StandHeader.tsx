import { msg, plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	CalendarPlus,
	ChevronLeft,
	ChevronRight,
	CloudOff,
	LayoutGrid,
	List,
	ListPlus,
	Rows3,
	UserPlus,
} from 'lucide-react'
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
} from '~/ui/primitives.tsx'

export type MainView = 'floor' | 'timeline'
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
			className={cn('bk-tabs', className)}
			style={{ '--n': options.length, '--i': index } as React.CSSProperties}
			onKeyDown={(event) => {
				if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
				event.preventDefault()
				const rtl = getComputedStyle(event.currentTarget).direction === 'rtl'
				const step = (event.key === 'ArrowRight') !== rtl ? 1 : -1
				const usable = options.filter((option) => !option.disabled)
				const at = usable.findIndex((option) => option.value === value)
				const next = usable[(at + step + usable.length) % usable.length]
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
			<span aria-hidden className="bk-tabs-pill" />
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
					className="bk-tab"
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
					'leading-tight font-semibold',
					inline ? 'text-sm' : 'text-base',
				)}
			>
				<NumberPop value={parties} className="tnum text-foreground" />
				{' · '}
				<NumberPop value={covers} className="tnum text-foreground" />
			</p>
			<p className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-sm leading-tight">
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
 * The top of the host stand: which day and service is on screen, how to look
 * at it (floor or timeline), and the three things a host does all shift: seat
 * a walk-in, add to the waitlist, take a booking. One row from iPad landscape
 * up (the day's figures sit in its corner on a wide screen, in the pane's own
 * toolbar below that); a phone has two short rows.
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
	view,
	onView,
	waitlistOn,
	stale,
	onWalkIn,
	onWaitlist,
	onBooking,
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
	/** Two panes: the Floor | Timeline switch lives here (a phone has tabs instead). */
	wide: boolean
	view: MainView
	onView: (view: MainView) => void
	waitlistOn: boolean
	stale: boolean
	onWalkIn: () => void
	onWaitlist: () => void
	onBooking: () => void
}) {
	const { _, i18n } = useLingui()
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
		<header
			className="bk-header"
			data-wide={wide}
			aria-label={_(msg`Today’s book`)}
		>
			{wide ? <div className="bk-stats-xl">{stats}</div> : null}

			<div className="bk-datebar">
				<IconButton
					label={_(msg`Previous day`)}
					onClick={() => go(-1)}
					className="border-border bg-card border"
				>
					<ChevronLeft className="size-5 rtl:rotate-180" />
				</IconButton>
				<label className="bk-date">
					<span className="tnum" aria-hidden>
						{label}
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
				<IconButton
					label={_(msg`Next day`)}
					onClick={() => go(1)}
					className="border-border bg-card border"
				>
					<ChevronRight className="size-5 rtl:rotate-180" />
				</IconButton>
				{wide && !isToday ? (
					<Button variant="outline" onClick={() => onDate(null)}>
						<Trans>Today</Trans>
					</Button>
				) : null}
			</div>

			<div className="bk-services">
				{services.length > 0 && !wide ? (
					// A phone has no room for the segments: a plain choice list.
					<select
						aria-label={_(msg`Service`)}
						value={serviceId ?? ''}
						onChange={(event) => onService(event.target.value || null)}
						className="border-border bg-card h-11 w-full min-w-0 rounded-xl border px-3 text-sm font-semibold"
					>
						<option value="">{_(msg`All day`)}</option>
						{services.map((s) => (
							<option key={s.id} value={s.id}>
								{s.name}
							</option>
						))}
					</select>
				) : services.length > 0 ? (
					<Segmented
						label={_(msg`Service`)}
						value={serviceId ?? ''}
						onChange={(value) => onService(value || null)}
						options={[
							{ value: '', label: _(msg`All day`) },
							...services.map((s) => ({ value: s.id, label: s.name })),
						]}
						wrap={false}
					/>
				) : (
					<span className="bg-muted inline-flex min-h-11 items-center rounded-2xl px-4 text-sm font-semibold">
						<Trans>All day</Trans>
					</span>
				)}
			</div>

			{!wide ? (
				<div className="bk-stats-phone">
					{!isToday ? (
						<Button variant="outline" onClick={() => onDate(null)}>
							<Trans>Today</Trans>
						</Button>
					) : null}
					{stats}
				</div>
			) : null}

			<div className="bk-actions">
				{/* Always present, so going stale is announced. */}
				<span role="status" className="contents">
					{stale ? (
						<span
							className="text-warning inline-flex items-center gap-1 text-sm font-medium"
							title={_(msg`Not up to date`)}
						>
							<CloudOff className="size-4" />
							<span className="max-xl:sr-only">
								<Trans>Not up to date</Trans>
							</span>
						</span>
					) : null}
				</span>
				{wide ? (
					<ViewTabs
						label={_(msg`View`)}
						value={isToday ? view : 'timeline'}
						onChange={onView}
						options={[
							{
								value: 'floor',
								label: _(msg`Floor`),
								icon: <LayoutGrid className="size-4" />,
								disabled: !isToday,
								compact: true,
							},
							{
								value: 'timeline',
								label: _(msg`Timeline`),
								icon: <Rows3 className="size-4" />,
								compact: true,
							},
						]}
					/>
				) : null}
				<Button
					variant="outline"
					onClick={onWalkIn}
					disabled={!isToday}
					aria-label={_(msg`Walk-in`)}
					title={_(msg`Walk-in`)}
				>
					<UserPlus className="size-4" />
					<span className="bk-action-label">
						<Trans>Walk-in</Trans>
					</span>
				</Button>
				{waitlistOn ? (
					<Button
						variant="outline"
						onClick={onWaitlist}
						disabled={!isToday}
						aria-label={_(msg`Add to the waitlist`)}
						title={_(msg`Add to the waitlist`)}
					>
						<ListPlus className="size-4" />
						<span className="bk-action-label">
							<Trans>Waitlist</Trans>
						</span>
					</Button>
				) : null}
				<Button
					variant="primary"
					onClick={onBooking}
					aria-label={_(msg`New booking`)}
					title={_(msg`New booking`)}
				>
					<CalendarPlus className="size-4" />
					<span className="bk-action-label">
						<Trans>Book</Trans>
					</span>
				</Button>
			</div>
		</header>
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
						icon: <List className="size-4 max-[430px]:hidden" />,
					},
					{
						value: 'floor',
						label: _(msg`Floor`),
						icon: <LayoutGrid className="size-4 max-[430px]:hidden" />,
						disabled: !floorOn,
					},
					{
						value: 'timeline',
						label: _(msg`Timeline`),
						icon: <Rows3 className="size-4 max-[430px]:hidden" />,
					},
				]}
			/>
		</div>
	)
}
