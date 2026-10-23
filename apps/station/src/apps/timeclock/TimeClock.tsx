import { plural, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type ClockEvent } from '@repo/staffing'
import { ClockApiError, ClockNetworkError } from '@repo/staffing/clock-client'
import {
	flowReducer,
	IDLE_SECONDS,
	nextStepFor,
	startFlow,
	type Flow,
	type Notice,
} from '@repo/staffing/clock-flow'
import { QueueUnavailableError } from '@repo/staffing/clock-queue'
import {
	ArrowLeft,
	BriefcaseBusiness,
	CalendarClock,
	CloudOff,
	Coffee,
	LogIn,
	LogOut,
	type LucideIcon,
} from 'lucide-react'
import {
	useCallback,
	useEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from 'react'
import { punchQueue, stationClockApi } from './clock.ts'
import { clockNotice, EVENT_DONE, EVENT_LABEL, STATE_LINE } from './messages.ts'
import { clockIsOff, useClock } from '~/lib/clock.ts'
import { type PosSettings } from '~/lib/config.ts'
import { moneyFormatter } from '~/lib/money.ts'
import { Keypad } from '~/ui/Keypad.tsx'
import { Stagger, SuccessMark } from '~/ui/motion.tsx'
import { PinDots } from '~/ui/PinDots.tsx'
import { Button, cn, NumberPop } from '~/ui/primitives.tsx'

const EVENT_ICON: Record<ClockEvent, LucideIcon> = {
	clock_in: LogIn,
	break_start: Coffee,
	break_end: BriefcaseBusiness,
	clock_out: LogOut,
}

/** An offline till shows every action: it cannot know where the person stands. */
const ALL_EVENTS: ClockEvent[] = [
	'clock_in',
	'break_start',
	'break_end',
	'clock_out',
]

/**
 * The time clock on the till. A person types their PIN (every time: a signed-in
 * till never punches for anyone), sees where they stand, and taps what they
 * are doing. The same flow as the wall kiosk, on the terminal's own pairing.
 *
 * Offline, the choice is saved on the tablet with the PIN encrypted and sent
 * when the connection is back; the server still checks the PIN and the order.
 *
 * Two pages slide side by side (page side-by-side): the PIN pad, and whatever
 * follows it. The clock face on the side is the screen's anchor.
 */
export function TimeClock({
	settings,
	online,
	businessName,
	locationName,
	currency,
	onClose,
}: {
	settings: PosSettings
	online: boolean
	businessName: string
	locationName: string | null
	/** For declaring cash tips. */
	currency: string
	/** From the lock screen: back to signing in. */
	onClose?: () => void
}) {
	const { _, i18n } = useLingui()
	const [flow, dispatch] = useReducer(flowReducer, startFlow('pin'))
	const [busy, setBusy] = useState(false)
	const busyRef = useRef(false)
	const [waiting, setWaiting] = useState(0)
	const api = useMemo(() => stationClockApi(settings), [settings])
	const reset = useCallback(() => dispatch({ type: 'reset', mode: 'pin' }), [])

	const refreshWaiting = useCallback(() => {
		const queue = punchQueue()
		if (!queue.supported) return
		void queue.counts().then(
			(counts) => setWaiting(counts.queued),
			() => {},
		)
	}, [])
	useEffect(() => {
		refreshWaiting()
		const timer = window.setInterval(refreshWaiting, 5_000)
		return () => window.clearInterval(timer)
	}, [refreshWaiting])

	// A screen nobody touches goes back to the pad; a half-typed PIN is forgotten.
	useEffect(() => {
		const idle =
			flow.screen === 'pin'
				? flow.pin.length > 0
					? 30
					: null
				: IDLE_SECONDS[flow.screen]
		if (idle === null) return
		const timer = window.setTimeout(reset, idle * 1000)
		return () => window.clearTimeout(timer)
	}, [flow, reset])

	// A wrong-PIN wait counts down on the monotonic clock.
	const pausedUntil = flow.screen === 'pin' ? flow.pausedUntil : null
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		if (pausedUntil === null) return
		const timer = window.setInterval(() => setNow(Date.now()), 500)
		return () => window.clearInterval(timer)
	}, [pausedUntil])
	const secondsLeft =
		pausedUntil === null
			? 0
			: Math.max(0, Math.ceil((pausedUntil - now) / 1000))
	useEffect(() => {
		if (pausedUntil !== null && secondsLeft === 0) dispatch({ type: 'clear' })
	}, [pausedUntil, secondsLeft])

	const reject = useCallback((error: unknown) => {
		let notice: Notice
		if (error instanceof ClockApiError) {
			notice = {
				code: error.code,
				retryAfterSeconds: error.retryAfterSeconds || undefined,
			}
		} else if (error instanceof QueueUnavailableError) {
			notice = { code: 'queue_unavailable' }
		} else if (error instanceof ClockNetworkError) {
			notice = { code: 'network_unavailable' }
		} else {
			notice = { code: 'unknown' }
		}
		dispatch({ type: 'rejected', notice, now: Date.now(), mode: 'pin' })
	}, [])

	const submitPin = useCallback(async () => {
		if (flow.screen !== 'pin' || busyRef.current || flow.pin.length < 4) return
		if (flow.pausedUntil !== null) return
		if (!online) {
			dispatch({ type: 'offline' })
			return
		}
		busyRef.current = true
		setBusy(true)
		try {
			const who = await api.identify(flow.pin)
			dispatch({ type: 'identified', who })
		} catch (error) {
			if (error instanceof ClockNetworkError) dispatch({ type: 'offline' })
			else reject(error)
		} finally {
			busyRef.current = false
			setBusy(false)
		}
	}, [flow, online, api, reject])

	/**
	 * Sends a punch. Its id is made once and reused if the answer is lost, so a
	 * retry (now or from the queue) never records the same punch twice.
	 */
	const punch = useCallback(
		async (
			event: ClockEvent,
			extras: { positionId?: string; cashTipsMinor?: number } = {},
		) => {
			if (flow.screen === 'pin' || flow.screen === 'done') return
			if (flow.screen === 'people' || busyRef.current) return
			const { pin } = flow
			const firstName = flow.screen === 'offline' ? '' : flow.who.firstName
			busyRef.current = true
			setBusy(true)
			const id = crypto.randomUUID()
			const tappedAt = Date.now()
			const body = {
				id,
				kind: event,
				pin,
				...(extras.positionId ? { positionId: extras.positionId } : {}),
				...(extras.cashTipsMinor !== undefined
					? { cashTipsMinor: extras.cashTipsMinor }
					: {}),
				clientAt: tappedAt,
			}
			const saveForLater = async () => {
				await punchQueue().enqueue({ ...body, createdAt: tappedAt })
				refreshWaiting()
				dispatch({
					type: 'done',
					done: { kind: event, firstName, at: null, queued: true },
				})
			}
			try {
				if (flow.screen === 'offline') {
					await saveForLater()
					return
				}
				const result = await api.punch({
					...body,
					deviceNowAt: tappedAt,
					offline: false,
				})
				dispatch({
					type: 'done',
					done: {
						kind: result.kind,
						firstName: result.firstName,
						at: result.at,
						queued: false,
					},
				})
			} catch (error) {
				if (error instanceof ClockNetworkError) {
					try {
						await saveForLater()
					} catch (queueError) {
						reject(queueError)
					}
				} else if (
					error instanceof ClockApiError &&
					error.code === 'position_required' &&
					flow.screen === 'actions'
				) {
					dispatch({ type: 'chooseRole' })
				} else {
					reject(error)
				}
			} finally {
				busyRef.current = false
				setBusy(false)
			}
		},
		[flow, api, reject, refreshWaiting],
	)

	const choose = (event: ClockEvent) => {
		if (flow.screen !== 'actions') return void punch(event)
		const step = nextStepFor(flow, event)
		if (step === 'role') dispatch({ type: 'chooseRole' })
		else if (step === 'tips') dispatch({ type: 'chooseTips', positionId: null })
		else void punch(event)
	}

	return (
		<div
			className="bg-background flex min-h-0 flex-1 flex-col lg:flex-row"
			onKeyDown={(event) => {
				if (flow.screen !== 'pin' || busy) return
				if (/^\d$/.test(event.key))
					dispatch({ type: 'digit', digit: event.key })
				else if (event.key === 'Backspace') dispatch({ type: 'backspace' })
				else if (event.key === 'Enter') void submitPin()
			}}
		>
			<ClockFace
				businessName={businessName}
				locationName={locationName}
				waiting={waiting}
				online={online}
				onClose={onClose}
			/>
			<section
				aria-label={_(t`Time clock`)}
				className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto p-4 sm:p-6 lg:items-center"
			>
				<div
					// Pages sit on top of each other; this keeps the taller one's room.
					className={cn(
						't-page-slide w-full max-w-md',
						flow.screen === 'pin' ? 'min-h-136' : 'min-h-120',
					)}
					data-page={flow.screen === 'pin' ? '1' : '2'}
				>
					<div
						className="t-page"
						data-page-id="1"
						inert={flow.screen !== 'pin'}
					>
						{flow.screen === 'pin' ? (
							<PinPage
								flow={flow}
								busy={busy}
								secondsLeft={secondsLeft}
								online={online}
								onDigits={(next) => {
									const current = flow.pin
									if (next === '') dispatch({ type: 'clear' })
									else if (next.length < current.length)
										dispatch({ type: 'backspace' })
									else dispatch({ type: 'digit', digit: next.slice(-1) })
								}}
								onSubmit={() => void submitPin()}
							/>
						) : (
							<PinPage
								flow={startFlow('pin') as Extract<Flow, { screen: 'pin' }>}
								busy={false}
								secondsLeft={0}
								online={online}
								onDigits={() => {}}
								onSubmit={() => {}}
							/>
						)}
					</div>
					<div
						className="t-page"
						data-page-id="2"
						inert={flow.screen === 'pin'}
					>
						{flow.screen !== 'pin' && flow.screen !== 'people' ? (
							<Stagger
								replay={flow.screen}
								className="flex h-full flex-col gap-5"
							>
								{flow.screen === 'actions' ? (
									<Actions
										flow={flow}
										busy={busy}
										onChoose={choose}
										onBack={reset}
										locale={i18n.locale}
									/>
								) : flow.screen === 'role' ? (
									<RolePick
										flow={flow}
										busy={busy}
										locale={i18n.locale}
										onPick={(positionId) =>
											void punch('clock_in', { positionId })
										}
										onBack={reset}
									/>
								) : flow.screen === 'tips' ? (
									<Tips
										currency={currency}
										busy={busy}
										onSkip={() => void punch('clock_out')}
										onDeclare={(cashTipsMinor) =>
											void punch('clock_out', { cashTipsMinor })
										}
										onBack={reset}
									/>
								) : flow.screen === 'offline' ? (
									<OfflineActions
										busy={busy}
										onChoose={(event) => void punch(event)}
										onBack={reset}
									/>
								) : flow.screen === 'done' ? (
									<Done done={flow.done} onFinish={reset} />
								) : null}
							</Stagger>
						) : null}
					</div>
				</div>
			</section>
		</div>
	)
}

/** The anchor: the time, big, where staff glance at it on the way in. */
function ClockFace({
	businessName,
	locationName,
	waiting,
	online,
	onClose,
}: {
	businessName: string
	locationName: string | null
	waiting: number
	online: boolean
	onClose?: () => void
}) {
	const { i18n } = useLingui()
	const [now, setNow] = useState(() => new Date())
	useEffect(() => {
		const timer = window.setInterval(() => setNow(new Date()), 1000)
		return () => window.clearInterval(timer)
	}, [])
	// The till's clock may be off; punches then count at the server's time.
	const skewed = clockIsOff(useClock((s) => s.skewMs))
	const time = new Intl.DateTimeFormat(i18n.locale, {
		hour: 'numeric',
		minute: '2-digit',
	}).format(now)
	const date = new Intl.DateTimeFormat(i18n.locale, {
		weekday: 'long',
		month: 'long',
		day: 'numeric',
	}).format(now)
	return (
		<aside className="border-border bg-card flex shrink-0 flex-col gap-6 border-b p-5 sm:p-6 lg:w-[38%] lg:max-w-xl lg:justify-between lg:border-e lg:border-b-0 lg:p-10">
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<p className="truncate font-semibold">{businessName}</p>
					{locationName ? (
						<p className="text-muted-foreground truncate text-sm">
							{locationName}
						</p>
					) : null}
				</div>
				{onClose ? (
					<Button variant="outline" onClick={onClose} className="shrink-0">
						<ArrowLeft className="size-4 rtl:rotate-180" />
						<Trans>Back to sign in</Trans>
					</Button>
				) : null}
			</div>
			<div className="flex items-end justify-between gap-4 lg:flex-col lg:items-start">
				<div>
					<p
						className="mono text-5xl leading-none font-semibold tracking-tight sm:text-6xl lg:text-8xl"
						aria-live="off"
					>
						<NumberPop value={time} />
					</p>
					<p className="text-muted-foreground mt-3 text-base sm:text-lg">
						{date}
					</p>
				</div>
				<div className="flex flex-col items-end gap-2 lg:items-start">
					{waiting > 0 ? (
						<p className="bg-warning/12 text-warning inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold">
							<CloudOff className="size-4 shrink-0" />
							{plural(waiting, {
								one: '# punch waiting to send',
								other: '# punches waiting to send',
							})}
						</p>
					) : null}
					{!online ? (
						<p className="text-muted-foreground text-sm">
							<Trans>Offline: punches are saved and sent later.</Trans>
						</p>
					) : null}
					{skewed ? (
						<p className="text-muted-foreground text-sm">
							<Trans>
								This tablet’s clock is off. Punches use the server’s time.
							</Trans>
						</p>
					) : null}
				</div>
			</div>
		</aside>
	)
}

function PinPage({
	flow,
	busy,
	secondsLeft,
	online,
	onDigits,
	onSubmit,
}: {
	flow: Extract<Flow, { screen: 'pin' }>
	busy: boolean
	secondsLeft: number
	online: boolean
	onDigits: (next: string) => void
	onSubmit: () => void
}) {
	const { _ } = useLingui()
	const waiting = flow.pausedUntil !== null && secondsLeft > 0
	const notice = flow.notice
		? clockNotice(flow.notice.code, waiting ? secondsLeft : 0)
		: null
	// Each refusal shakes the dots once.
	const [rejected, setRejected] = useState(0)
	const lastNotice = useRef<Notice | null>(null)
	useEffect(() => {
		if (flow.notice && flow.notice !== lastNotice.current)
			setRejected((n) => n + 1)
		lastNotice.current = flow.notice
	}, [flow.notice])
	return (
		<div className="flex h-full flex-col gap-5">
			<div className="text-center">
				<h2 className="text-2xl font-bold">
					<Trans>Enter your PIN</Trans>
				</h2>
				<p className="text-muted-foreground mt-1">
					<Trans>To clock in, take a break or clock out.</Trans>
				</p>
			</div>
			<PinDots length={flow.pin.length} rejected={rejected} />
			<div className="min-h-11 text-center">
				<p
					role="alert"
					className={cn(
						'text-sm font-medium empty:hidden',
						notice?.kind === 'offline' ? 'text-warning' : 'text-destructive',
					)}
				>
					{notice ? _(notice.message) : null}
				</p>
				{!notice && !online ? (
					<p className="text-muted-foreground flex items-center justify-center gap-2 text-sm">
						<CloudOff className="size-4" />
						<Trans>Offline: your punch is saved and sent later.</Trans>
					</p>
				) : null}
			</div>
			<Keypad
				value={flow.pin}
				onChange={(next) => !busy && !waiting && onDigits(next.slice(0, 6))}
				maxDigits={6}
				raw
			/>
			<Button
				variant="primary"
				size="xl"
				className="w-full"
				disabled={flow.pin.length < 4 || busy || waiting}
				onClick={onSubmit}
			>
				{busy ? (
					<span className="t-shimmer">
						<Trans>Checking…</Trans>
					</span>
				) : (
					<Trans>Continue</Trans>
				)}
			</Button>
		</div>
	)
}

function BackLink({ onBack }: { onBack: () => void }) {
	return (
		<button
			type="button"
			onClick={onBack}
			className="text-muted-foreground hover:text-foreground -ms-2 inline-flex h-11 items-center gap-1.5 self-start rounded-xl px-2 text-sm font-medium transition-colors"
		>
			<ArrowLeft className="size-4 rtl:rotate-180" />
			<Trans>Not me</Trans>
		</button>
	)
}

function EventTile({
	event,
	primary,
	busy,
	onChoose,
}: {
	event: ClockEvent
	primary: boolean
	busy: boolean
	onChoose: (event: ClockEvent) => void
}) {
	const { _ } = useLingui()
	const Icon = EVENT_ICON[event]
	return (
		<button
			type="button"
			disabled={busy}
			onClick={() => onChoose(event)}
			className={cn(
				'flex min-h-24 flex-col items-start justify-between gap-3 rounded-2xl border p-4 text-start transition active:scale-[0.97] disabled:opacity-50',
				primary
					? 'border-primary bg-primary text-primary-foreground elevated-card'
					: 'border-border bg-card hover:bg-accent',
			)}
		>
			<Icon className="size-6" aria-hidden />
			<span className="text-lg font-semibold">{_(EVENT_LABEL[event])}</span>
		</button>
	)
}

function Actions({
	flow,
	busy,
	onChoose,
	onBack,
	locale,
}: {
	flow: Extract<Flow, { screen: 'actions' }>
	busy: boolean
	onChoose: (event: ClockEvent) => void
	onBack: () => void
	locale: string
}) {
	const { _ } = useLingui()
	const { who } = flow
	const shiftTime = new Intl.DateTimeFormat(locale, {
		weekday: 'short',
		hour: 'numeric',
		minute: '2-digit',
	})
	const endTime = new Intl.DateTimeFormat(locale, {
		hour: 'numeric',
		minute: '2-digit',
	})
	return (
		<>
			<BackLink onBack={onBack} />
			<div>
				<h2 className="t-stagger-line text-3xl font-bold">
					<Trans>Hi {who.firstName}</Trans>
				</h2>
				<p className="t-stagger-line t-stagger-line--2 text-muted-foreground mt-1 text-lg">
					{_(STATE_LINE[who.state])}
				</p>
			</div>
			{who.allowedEvents.length > 0 ? (
				<div className="t-stagger-line t-stagger-line--3 grid grid-cols-2 gap-3">
					{who.allowedEvents.map((event, index) => (
						<EventTile
							key={event}
							event={event}
							primary={index === 0}
							busy={busy}
							onChoose={onChoose}
						/>
					))}
				</div>
			) : (
				<p className="t-stagger-line t-stagger-line--3 text-muted-foreground">
					<Trans>There is nothing to punch right now. Ask a manager.</Trans>
				</p>
			)}
			{who.nextShifts.length > 0 ? (
				<div className="t-stagger-line t-stagger-line--3 border-border rounded-2xl border p-4">
					<p className="text-muted-foreground flex items-center gap-2 text-sm font-medium">
						<CalendarClock className="size-4" />
						<Trans>Your next shifts</Trans>
					</p>
					<ul className="mt-2 space-y-1">
						{who.nextShifts.map((shift) => (
							<li key={shift.startAt} className="tnum flex justify-between">
								<span>{shiftTime.format(shift.startAt)}</span>
								<span className="text-muted-foreground">
									{endTime.format(shift.endAt)}
								</span>
							</li>
						))}
					</ul>
				</div>
			) : null}
		</>
	)
}

function RolePick({
	flow,
	busy,
	locale,
	onPick,
	onBack,
}: {
	flow: Extract<Flow, { screen: 'role' }>
	busy: boolean
	locale: string
	onPick: (positionId: string) => void
	onBack: () => void
}) {
	return (
		<>
			<BackLink onBack={onBack} />
			<h2 className="t-stagger-line text-3xl font-bold">
				<Trans>What are you working today?</Trans>
			</h2>
			<div className="t-stagger-line t-stagger-line--2 flex flex-col gap-2">
				{flow.who.positions.map((position) => (
					<Button
						key={position.id}
						variant="outline"
						size="lg"
						disabled={busy}
						className="justify-start"
						onClick={() => onPick(position.id)}
					>
						{locale === 'ar' && position.nameAr
							? position.nameAr
							: position.name}
					</Button>
				))}
			</div>
		</>
	)
}

function Tips({
	currency,
	busy,
	onSkip,
	onDeclare,
	onBack,
}: {
	currency: string
	busy: boolean
	onSkip: () => void
	onDeclare: (minor: number) => void
	onBack: () => void
}) {
	const { _, i18n } = useLingui()
	// Digits as cents: 1-2-5-0 reads 12.50, so no decimal key is needed.
	const [cents, setCents] = useState('')
	const minor = Number(cents || '0')
	const amount = moneyFormatter(currency, i18n.locale)(minor)
	return (
		<>
			<BackLink onBack={onBack} />
			<div>
				<h2 className="t-stagger-line text-3xl font-bold">
					<Trans>Any cash tips this shift?</Trans>
				</h2>
				<p className="t-stagger-line t-stagger-line--2 text-muted-foreground mt-1">
					<Trans>
						Count what you kept in cash. Card tips are counted for you.
					</Trans>
				</p>
			</div>
			<p
				className="t-stagger-line t-stagger-line--2 mono text-center text-4xl font-semibold"
				aria-label={_(t`Cash tips ${amount}`)}
			>
				<NumberPop value={amount} />
			</p>
			<div className="t-stagger-line t-stagger-line--3">
				<Keypad
					value={cents}
					onChange={(next) => setCents(next)}
					maxDigits={6}
				/>
			</div>
			<div className="t-stagger-line t-stagger-line--3 grid grid-cols-2 gap-3">
				<Button variant="outline" size="lg" disabled={busy} onClick={onSkip}>
					<Trans>No cash tips</Trans>
				</Button>
				<Button
					variant="primary"
					size="lg"
					disabled={busy || minor === 0}
					onClick={() => onDeclare(minor)}
				>
					<Trans>Clock out</Trans>
				</Button>
			</div>
		</>
	)
}

function OfflineActions({
	busy,
	onChoose,
	onBack,
}: {
	busy: boolean
	onChoose: (event: ClockEvent) => void
	onBack: () => void
}) {
	return (
		<>
			<BackLink onBack={onBack} />
			<div>
				<h2 className="t-stagger-line text-3xl font-bold">
					<Trans>What are you doing?</Trans>
				</h2>
				<p className="t-stagger-line t-stagger-line--2 text-muted-foreground mt-1 flex items-start gap-2">
					<CloudOff className="mt-1 size-4 shrink-0" />
					<Trans>
						No connection. Your punch is saved on this terminal and sent when it
						is back; your PIN is checked then.
					</Trans>
				</p>
			</div>
			<div className="t-stagger-line t-stagger-line--3 grid grid-cols-2 gap-3">
				{ALL_EVENTS.map((event, index) => (
					<EventTile
						key={event}
						event={event}
						primary={index === 0}
						busy={busy}
						onChoose={onChoose}
					/>
				))}
			</div>
		</>
	)
}

function Done({
	done,
	onFinish,
}: {
	done: Extract<Flow, { screen: 'done' }>['done']
	onFinish: () => void
}) {
	const { _, i18n } = useLingui()
	const at =
		done.at === null
			? null
			: new Intl.DateTimeFormat(i18n.locale, {
					hour: 'numeric',
					minute: '2-digit',
				}).format(done.at)
	const label = _(EVENT_DONE[done.kind])
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
			<SuccessMark tone={done.queued ? 'muted' : 'success'} size="lg" />
			<h2 className="t-stagger-line text-3xl font-bold">
				{done.firstName ? (
					<Trans>
						{label}, {done.firstName}
					</Trans>
				) : (
					label
				)}
			</h2>
			<p className="t-stagger-line t-stagger-line--2 text-muted-foreground text-lg">
				{done.queued ? (
					<Trans>
						Saved on this terminal. It is sent when the connection is back.
					</Trans>
				) : at ? (
					<Trans>Recorded at {at}.</Trans>
				) : null}
			</p>
			<Button
				variant="outline"
				size="lg"
				className="t-stagger-line t-stagger-line--3 mt-2"
				onClick={onFinish}
			>
				<Trans>Done</Trans>
			</Button>
		</div>
	)
}
