import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type ClockEvent } from '@repo/staffing'
import { cn } from '@repo/ui'
import { Alert } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Icon, type IconName } from '@repo/ui/icon'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { PinDots, PinPad } from '#app/components/kiosk/pin-pad.tsx'
import {
	type KioskIdentifyView,
	type KioskPersonView,
} from '#app/utils/kiosk/kiosk-api.ts'
import {
	amountToMinor,
	type DoneInfo,
	type Notice,
} from '#app/utils/kiosk/kiosk-flow.ts'
import { describeKioskError } from '#app/utils/kiosk/kiosk-messages.ts'

/** The heading of a screen, focused when it appears so screen readers follow along. */
export function ScreenTitle({
	children,
	className,
}: {
	children: ReactNode
	className?: string
}) {
	const ref = useRef<HTMLHeadingElement>(null)
	useEffect(() => {
		ref.current?.focus({ preventScroll: true })
	}, [])
	return (
		<h1
			ref={ref}
			tabIndex={-1}
			className={cn(
				'text-2xl font-semibold tracking-tight text-balance outline-none md:text-4xl',
				className,
			)}
		>
			{children}
		</h1>
	)
}

function NoticeLine({ notice }: { notice: Notice | null }) {
	const { _ } = useLingui()
	if (!notice) {
		return <div className="min-h-10 landscape:min-h-0" aria-hidden="true" />
	}
	const described = describeKioskError(notice.code, {
		retryAfterSeconds: notice.retryAfterSeconds,
	})
	return (
		<Alert variant="destructive" className="min-h-12 items-center">
			<Icon name="alert-triangle" />
			<p className="text-lg font-medium text-balance">{_(described.message)}</p>
		</Alert>
	)
}

// ---------------------------------------------------------------------------
// PIN
// ---------------------------------------------------------------------------

export function PinScreen({
	pin,
	personName,
	notice,
	pausedUntil,
	busy,
	onDigit,
	onBackspace,
	onSubmit,
	onBack,
}: {
	pin: string
	personName: string | null
	notice: Notice | null
	pausedUntil: number | null
	busy: boolean
	onDigit: (digit: string) => void
	onBackspace: () => void
	onSubmit: () => void
	onBack?: () => void
}) {
	const [now, setNow] = useState(() => Date.now())
	const paused = pausedUntil !== null && now < pausedUntil
	useEffect(() => {
		if (pausedUntil === null) return
		const timer = setInterval(() => setNow(Date.now()), 500)
		return () => clearInterval(timer)
	}, [pausedUntil])
	const secondsLeft = paused ? Math.ceil((pausedUntil - now) / 1000) : 0
	// While paused the pad says how long; the standing message would go stale.
	const shownNotice: Notice | null = paused
		? { code: 'backoff', retryAfterSeconds: secondsLeft }
		: pausedUntil !== null
			? null
			: notice

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			<div className="flex flex-col items-center gap-1 text-center">
				<ScreenTitle>
					{personName ? (
						<Trans>Hi {personName}, enter your PIN</Trans>
					) : (
						<Trans>Enter your PIN</Trans>
					)}
				</ScreenTitle>
			</div>
			<PinDots length={pin.length} />
			<NoticeLine notice={shownNotice} />
			<PinPad
				onDigit={onDigit}
				onBackspace={onBackspace}
				onSubmit={onSubmit}
				submitLabel={t`Continue`}
				submitDisabled={pin.length < 4 || busy}
				disabled={busy || paused}
			/>
			{onBack ? (
				<Button
					type="button"
					variant="ghost"
					className="h-12 touch-manipulation text-lg"
					onClick={onBack}
				>
					<Icon name="arrow-left" className="rtl:rotate-180" />
					<Trans>Not me</Trans>
				</Button>
			) : null}
		</div>
	)
}

// ---------------------------------------------------------------------------
// Pick a name
// ---------------------------------------------------------------------------

const PAGE_SIZE = 8

export function PeopleScreen({
	people,
	loading,
	notice,
	onPick,
}: {
	people: readonly KioskPersonView[]
	loading: boolean
	notice: Notice | null
	onPick: (person: KioskPersonView) => void
}) {
	const { _, i18n } = useLingui()
	const [letter, setLetter] = useState<string | null>(null)
	const [page, setPage] = useState(0)

	const letters = useMemo(
		() =>
			[
				...new Set(
					people.map((person) =>
						Array.from(person.firstName)[0]?.toLocaleUpperCase(i18n.locale),
					),
				),
			]
				.filter((value): value is string => Boolean(value))
				.sort((a, b) => a.localeCompare(b, i18n.locale)),
		[people, i18n.locale],
	)
	const filtered = letter
		? people.filter(
				(person) =>
					Array.from(person.firstName)[0]?.toLocaleUpperCase(i18n.locale) ===
					letter,
			)
		: people
	const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
	const safePage = Math.min(page, pages - 1)
	const shown = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			<ScreenTitle>
				<Trans>Who are you?</Trans>
			</ScreenTitle>
			<NoticeLine notice={notice} />
			{people.length > PAGE_SIZE ? (
				<div
					role="group"
					aria-label={_(t`Filter by first letter`)}
					className="flex flex-wrap gap-2"
				>
					<Button
						type="button"
						variant={letter === null ? 'default' : 'outline'}
						className="h-11 min-w-11 touch-manipulation rounded-full"
						aria-pressed={letter === null}
						onClick={() => {
							setLetter(null)
							setPage(0)
						}}
					>
						<Trans>All</Trans>
					</Button>
					{letters.map((value) => (
						<Button
							key={value}
							type="button"
							variant={letter === value ? 'default' : 'outline'}
							className="h-11 min-w-11 touch-manipulation rounded-full"
							aria-pressed={letter === value}
							onClick={() => {
								setLetter(value)
								setPage(0)
							}}
						>
							{value}
						</Button>
					))}
				</div>
			) : null}
			{loading ? (
				<p role="status" className="text-muted-foreground text-lg">
					<Trans>Loading names…</Trans>
				</p>
			) : people.length === 0 ? (
				<p className="text-lg text-balance">
					<Trans>No names to show. Ask a manager to set up your PIN.</Trans>
				</p>
			) : (
				<ul className="grid min-h-0 flex-1 grid-cols-2 grid-rows-4 gap-2 md:gap-3">
					{shown.map((person) => (
						<li key={person.staffId} className="flex min-h-0">
							<Button
								type="button"
								variant="outline"
								className="h-full w-full touch-manipulation flex-col items-start justify-center gap-0 rounded-2xl px-4 text-xl font-semibold active:scale-95 motion-reduce:active:scale-100"
								onClick={() => onPick(person)}
							>
								<span className="truncate">{person.firstName}</span>
								{person.lastInitial ? (
									<span className="text-muted-foreground text-base font-normal">
										{person.lastInitial}.
									</span>
								) : null}
							</Button>
						</li>
					))}
				</ul>
			)}
			{pages > 1 ? (
				<div className="flex items-center justify-between gap-3">
					<Button
						type="button"
						variant="outline"
						className="h-12 touch-manipulation"
						disabled={safePage === 0}
						onClick={() => setPage(safePage - 1)}
					>
						<Icon name="chevron-left" className="rtl:rotate-180" />
						<Trans>Back</Trans>
					</Button>
					<span className="text-base tabular-nums">
						{safePage + 1} / {pages}
					</span>
					<Button
						type="button"
						variant="outline"
						className="h-12 touch-manipulation"
						disabled={safePage >= pages - 1}
						onClick={() => setPage(safePage + 1)}
					>
						<Trans>Next</Trans>
						<Icon name="chevron-right" className="rtl:rotate-180" />
					</Button>
				</div>
			) : null}
		</div>
	)
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const ACTION_ICONS: Record<ClockEvent, IconName> = {
	clock_in: 'play',
	break_start: 'clock',
	break_end: 'play',
	clock_out: 'log-out',
}

/** "Tue, Mar 3" and "9 AM – 5 PM" in the workplace's time zone, in the tablet's language. */
function shiftLabels(
	shift: { startAt: number; endAt: number },
	timeZone: string | null,
	locale: string,
): { day: string; range: string } {
	const zone = timeZone ?? undefined
	try {
		const day = new Intl.DateTimeFormat(locale, {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			timeZone: zone,
		}).format(shift.startAt)
		const time = new Intl.DateTimeFormat(locale, {
			hour: 'numeric',
			minute: '2-digit',
			timeZone: zone,
		})
		return {
			day,
			range: `${time.format(shift.startAt)} – ${time.format(shift.endAt)}`,
		}
	} catch {
		return { day: '', range: '' }
	}
}

/**
 * The person's own next shifts, only on a tablet a manager chose to show them
 * on. Times only, for the person who just entered their PIN.
 */
function NextShifts({
	shifts,
	timeZone,
}: {
	shifts: ReadonlyArray<{ startAt: number; endAt: number }>
	timeZone: string | null
}) {
	const { i18n } = useLingui()
	if (shifts.length === 0) return null
	return (
		<section
			aria-labelledby="next-shifts-heading"
			className="flex flex-col gap-1"
		>
			<h2
				id="next-shifts-heading"
				className="text-muted-foreground text-base font-medium"
			>
				<Trans>Your next shifts</Trans>
			</h2>
			<ul className="flex flex-col gap-0.5 text-lg">
				{shifts.map((shift) => {
					const label = shiftLabels(shift, timeZone, i18n.locale)
					return (
						<li
							key={shift.startAt}
							className="flex flex-wrap items-baseline justify-between gap-x-4 tabular-nums"
						>
							<span>{label.day}</span>
							<bdi>{label.range}</bdi>
						</li>
					)
				})}
			</ul>
		</section>
	)
}

export function ActionsScreen({
	who,
	busy,
	notice,
	timeZone = null,
	onChoose,
	onCancel,
}: {
	who: KioskIdentifyView
	busy: boolean
	notice: Notice | null
	timeZone?: string | null
	onChoose: (event: ClockEvent) => void
	onCancel: () => void
}) {
	const { _ } = useLingui()
	const labels: Record<ClockEvent, string> = {
		clock_in: _(t`Clock in`),
		break_start: _(t`Start break`),
		break_end: _(t`End break`),
		clock_out: _(t`Clock out`),
	}
	const stateLine = {
		out: _(t`You are clocked out.`),
		in: _(t`You are clocked in.`),
		on_break: _(t`You are on a break.`),
	}[who.state]
	// The action that moves the day forward is the loud one.
	const primary: ClockEvent | null =
		who.state === 'out'
			? 'clock_in'
			: who.state === 'on_break'
				? 'break_end'
				: 'clock_out'
	const events = who.allowedEvents
	const firstName = who.firstName

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-4">
			<div className="flex flex-col gap-1">
				<ScreenTitle>
					<Trans>Hi {firstName}</Trans>
				</ScreenTitle>
				<p className="text-muted-foreground text-xl">{stateLine}</p>
			</div>
			<NoticeLine notice={notice} />
			{events.length === 0 ? (
				<Alert>
					<p className="text-lg text-balance">
						<Trans>
							You cannot clock in or out on this tablet right now. Ask a
							manager.
						</Trans>
					</p>
				</Alert>
			) : (
				<div className="flex min-h-0 flex-1 flex-col gap-3">
					{events.map((event) => (
						<Button
							key={event}
							type="button"
							variant={event === primary ? 'default' : 'outline'}
							disabled={busy}
							className={cn(
								'min-h-20 flex-1 touch-manipulation gap-3 rounded-2xl text-2xl font-semibold active:scale-[0.98] motion-reduce:active:scale-100',
								event === primary ? '' : 'border-2',
							)}
							onClick={() => onChoose(event)}
						>
							<Icon name={ACTION_ICONS[event]} size="md" />
							{labels[event]}
						</Button>
					))}
				</div>
			)}
			<NextShifts shifts={who.nextShifts} timeZone={timeZone} />
			<Button
				type="button"
				variant="ghost"
				className="h-12 touch-manipulation text-lg"
				onClick={onCancel}
			>
				<Trans>Not me</Trans>
			</Button>
		</div>
	)
}

export function RoleScreen({
	who,
	locale,
	busy,
	onPick,
	onCancel,
}: {
	who: KioskIdentifyView
	locale: string
	busy: boolean
	onPick: (positionId: string) => void
	onCancel: () => void
}) {
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-4">
			<ScreenTitle>
				<Trans>What role are you working?</Trans>
			</ScreenTitle>
			<ul className="flex min-h-0 flex-1 flex-col gap-3">
				{who.positions.map((position) => (
					<li key={position.id} className="flex min-h-16 flex-1">
						<Button
							type="button"
							variant="outline"
							disabled={busy}
							className="h-full w-full touch-manipulation rounded-2xl border-2 text-2xl font-semibold active:scale-[0.98] motion-reduce:active:scale-100"
							onClick={() => onPick(position.id)}
						>
							{locale.startsWith('ar')
								? (position.nameAr ?? position.name)
								: position.name}
						</Button>
					</li>
				))}
			</ul>
			<Button
				type="button"
				variant="ghost"
				className="h-12 touch-manipulation text-lg"
				onClick={onCancel}
			>
				<Trans>Back</Trans>
			</Button>
		</div>
	)
}

// ---------------------------------------------------------------------------
// Tips
// ---------------------------------------------------------------------------

export function TipsScreen({
	amount,
	busy,
	onDigit,
	onBackspace,
	onSubmit,
	onSkip,
	onCancel,
}: {
	amount: string
	busy: boolean
	onDigit: (digit: string) => void
	onBackspace: () => void
	onSubmit: () => void
	onSkip: () => void
	onCancel: () => void
}) {
	const minor = amountToMinor(amount)
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			<div className="flex flex-col gap-1">
				<ScreenTitle>
					<Trans>Any cash tips this shift?</Trans>
				</ScreenTitle>
				<p className="text-muted-foreground text-lg">
					<Trans>Enter the amount you were handed, or skip.</Trans>
				</p>
			</div>
			<p
				role="status"
				dir="ltr"
				className="border-border flex h-16 items-center justify-center rounded-2xl border-2 text-4xl font-semibold tabular-nums"
			>
				{amount === '' ? '0' : amount}
			</p>
			<PinPad
				decimal
				disabled={busy}
				onDigit={onDigit}
				onBackspace={onBackspace}
			/>
			<div className="grid grid-cols-2 gap-3">
				<Button
					type="button"
					variant="outline"
					disabled={busy}
					className="h-14 touch-manipulation rounded-2xl border-2 text-xl"
					onClick={onSkip}
				>
					<Trans>No tips</Trans>
				</Button>
				<Button
					type="button"
					disabled={busy || minor === null}
					className="h-14 touch-manipulation rounded-2xl text-xl"
					onClick={onSubmit}
				>
					<Trans>Clock out</Trans>
				</Button>
			</div>
			<Button
				type="button"
				variant="ghost"
				className="h-11 touch-manipulation text-base"
				onClick={onCancel}
			>
				<Trans>Back</Trans>
			</Button>
		</div>
	)
}

// ---------------------------------------------------------------------------
// Offline
// ---------------------------------------------------------------------------

export function OfflineScreen({
	busy,
	onChoose,
	onCancel,
}: {
	busy: boolean
	onChoose: (event: ClockEvent) => void
	onCancel: () => void
}) {
	const { _ } = useLingui()
	const options: Array<{ event: ClockEvent; label: string }> = [
		{ event: 'clock_in', label: _(t`Clock in`) },
		{ event: 'break_start', label: _(t`Start break`) },
		{ event: 'break_end', label: _(t`End break`) },
		{ event: 'clock_out', label: _(t`Clock out`) },
	]
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-4">
			<div className="flex flex-col gap-2">
				<ScreenTitle>
					<Trans>No connection</Trans>
				</ScreenTitle>
				<p className="text-lg text-balance">
					<Trans>
						Choose what you are doing. It is saved on this tablet and recorded
						as soon as the connection is back.
					</Trans>
				</p>
			</div>
			<div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-3">
				{options.map(({ event, label }) => (
					<Button
						key={event}
						type="button"
						variant="outline"
						disabled={busy}
						className="h-full touch-manipulation flex-col gap-2 rounded-2xl border-2 text-xl font-semibold active:scale-[0.98] motion-reduce:active:scale-100"
						onClick={() => onChoose(event)}
					>
						<Icon name={ACTION_ICONS[event]} size="lg" />
						{label}
					</Button>
				))}
			</div>
			<Button
				type="button"
				variant="ghost"
				className="h-12 touch-manipulation text-lg"
				onClick={onCancel}
			>
				<Trans>Cancel</Trans>
			</Button>
		</div>
	)
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

export function DoneScreen({
	done,
	timeZone,
	seconds,
	onDone,
}: {
	done: DoneInfo
	timeZone: string | null
	seconds: number
	onDone: () => void
}) {
	const { _, i18n } = useLingui()
	const firstName = done.firstName
	// A punch saved offline in PIN mode has no name yet (nothing could look it up).
	const named = firstName !== ''
	const heading = {
		clock_in: named ? _(t`Clocked in, ${firstName}`) : _(t`Clocked in`),
		break_start: named
			? _(t`Break started, ${firstName}`)
			: _(t`Break started`),
		break_end: named ? _(t`Welcome back, ${firstName}`) : _(t`Welcome back`),
		clock_out: named ? _(t`Clocked out, ${firstName}`) : _(t`Clocked out`),
	}[done.kind]
	let time: string | null = null
	if (done.at !== null) {
		try {
			time = new Intl.DateTimeFormat(i18n.locale, {
				hour: 'numeric',
				minute: '2-digit',
				timeZone: timeZone ?? undefined,
			}).format(done.at)
		} catch {
			time = new Intl.DateTimeFormat(i18n.locale, {
				hour: 'numeric',
				minute: '2-digit',
			}).format(done.at)
		}
	}
	return (
		<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 text-center">
			<Icon
				name={done.queued ? 'clock' : 'check-circle'}
				size="xl"
				className={done.queued ? 'text-foreground' : 'text-primary'}
				aria-hidden="true"
			/>
			<div className="flex flex-col gap-2">
				<ScreenTitle>{heading}</ScreenTitle>
				{time ? <p className="text-2xl tabular-nums">{time}</p> : null}
				{done.queued ? (
					<p className="text-xl text-balance">
						<Trans>
							Saved on this tablet. It will be recorded when the connection is
							back.
						</Trans>
					</p>
				) : null}
			</div>
			<div
				role="timer"
				aria-label={plural(seconds, {
					one: 'Closing in # second',
					other: 'Closing in # seconds',
				})}
				className="bg-muted h-2 w-full max-w-xs overflow-hidden rounded-full"
			>
				<div
					className="bg-primary h-full origin-left rounded-full transition-[width] duration-1000 ease-linear motion-reduce:transition-none rtl:origin-right"
					style={{
						width: `${Math.max(0, Math.min(100, (seconds / 5) * 100))}%`,
					}}
				/>
			</div>
			<Button
				type="button"
				variant="outline"
				className="h-14 min-w-40 touch-manipulation rounded-2xl border-2 text-xl"
				onClick={onDone}
			>
				<Trans>Done</Trans>
			</Button>
		</div>
	)
}
