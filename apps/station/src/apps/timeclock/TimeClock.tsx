import { msg, plural, Trans } from '@lingui/macro'
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
import { Icon, type IconName } from '@repo/ui/icon'
import {
	useCallback,
	useEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from 'react'
import {
	expirePunches,
	flushPunches,
	punchQueue,
	stationClockApi,
	worthSavingForLater,
} from './clock.ts'
import {
	BREAK_LABEL,
	clockNotice,
	EVENT_DONE,
	EVENT_LABEL,
	STATE_LINE,
} from './messages.ts'
import {
	findClockPerson,
	forgetClockPin,
	rememberClockPerson,
} from './roster.ts'
import { clockIsOff, serverNow, useClock } from '~/lib/clock.ts'
import { type PosSettings } from '~/lib/config.ts'
import { type ClockPerson } from '~/lib/db.ts'
import { moneyFormatter } from '~/lib/money.ts'
import { Keypad } from '~/ui/Keypad.tsx'
import { Stagger, SuccessMark } from '~/ui/motion.tsx'
import { PinDots } from '~/ui/PinDots.tsx'
import { Button, cn, Modal, NumberPop } from '~/ui/primitives.tsx'

const EVENT_ICON: Record<ClockEvent, IconName> = {
	clock_in: 'log-in',
	break_start: 'coffee',
	break_end: 'briefcase-business',
	clock_out: 'log-out',
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
	timeZone,
	onClose,
}: {
	settings: PosSettings
	online: boolean
	businessName: string
	locationName: string | null
	/** For declaring cash tips. */
	currency: string
	/** The location's: the clock and shift times read in the restaurant's time, not the tablet's. */
	timeZone?: string
	/** From the lock screen: back to signing in. */
	onClose?: () => void
}) {
	const { _, i18n } = useLingui()
	const [flow, dispatch] = useReducer(flowReducer, startFlow('pin'))
	const [busy, setBusy] = useState(false)
	const busyRef = useRef(false)
	const [waiting, setWaiting] = useState(0)
	const [failed, setFailed] = useState(0)
	const [failedOpen, setFailedOpen] = useState(false)
	/** Who an offline PIN belongs to, when this till has seen it online; null when not. */
	const [offlineWho, setOfflineWho] = useState<ClockPerson | null>(null)
	/** Why punches are being saved for later: no connection, or the server cannot judge them. */
	const [offlineReason, setOfflineReason] = useState<'offline' | 'unavailable'>(
		'offline',
	)
	/** Punches still waiting after trying to send them: what identify shows may be behind. */
	const [behind, setBehind] = useState(false)
	/** A break was chosen where the rules know more than one kind. */
	const [pickingBreak, setPickingBreak] = useState(false)
	// Which offline step is showing (actions, role, break or tips): focus and
	// the entrance follow it as they follow the screens.
	const [offlineStep, setOfflineStep] = useState('actions')
	/** Bumped by any touch, so a person still typing is not sent back to the pad. */
	const [touched, setTouched] = useState(0)
	const api = useMemo(() => stationClockApi(settings), [settings])
	const reset = useCallback(() => {
		setOfflineWho(null)
		setPickingBreak(false)
		dispatch({ type: 'reset', mode: 'pin' })
	}, [])

	const refreshWaiting = useCallback(() => {
		const queue = punchQueue()
		if (!queue.supported) return
		// Punches too old to record are set aside first, so the counts say so.
		void expirePunches()
			.catch(() => 0)
			.then(() => queue.counts())
			.then(
				(counts) => {
					setWaiting(counts.queued)
					setFailed(counts.failed)
				},
				() => {},
			)
	}, [])
	useEffect(() => {
		refreshWaiting()
		const timer = window.setInterval(refreshWaiting, 5_000)
		return () => window.clearInterval(timer)
	}, [refreshWaiting])

	// Focus follows the page: back on the pad, the clock itself takes the keys;
	// on the next page, its first button (focus would otherwise fall to nowhere
	// as the pad it was on goes inert).
	const rootRef = useRef<HTMLDivElement>(null)
	const pageTwoRef = useRef<HTMLDivElement>(null)
	const onPad = flow.screen === 'pin'
	useEffect(() => {
		const frame = requestAnimationFrame(() => {
			if (onPad) rootRef.current?.focus({ preventScroll: true })
			else {
				// The main action (never "Not me", so Enter does the expected thing).
				const page = pageTwoRef.current
				const target =
					page?.querySelector<HTMLElement>(
						'[data-autofocus]:not([disabled])',
					) ??
					page?.querySelector<HTMLElement>(
						'button:not([disabled]):not([data-back])',
					)
				target?.focus({ preventScroll: true })
			}
		})
		return () => cancelAnimationFrame(frame)
	}, [onPad, flow.screen, pickingBreak, offlineStep])

	// The break choice belongs to one person's actions screen, never the next one's.
	useEffect(() => {
		if (flow.screen !== 'actions') setPickingBreak(false)
	}, [flow.screen])

	// A screen nobody touches goes back to the pad; a half-typed PIN is forgotten.
	// Over the lock, a finished punch or an untouched pad goes back to signing
	// in, so a cashier's sign-in PIN is never typed into the clock by habit.
	useEffect(() => {
		const idle =
			flow.screen === 'pin'
				? flow.pin.length > 0
					? 30
					: onClose
						? 60
						: null
				: IDLE_SECONDS[flow.screen]
		if (idle === null) return
		const leave =
			onClose && (flow.screen === 'done' || flow.screen === 'pin')
				? onClose
				: reset
		const timer = window.setTimeout(leave, idle * 1000)
		return () => window.clearTimeout(timer)
	}, [flow, touched, reset, onClose])

	// A wrong-PIN wait counts down here; the server enforces it regardless.
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

	/**
	 * No answer about this PIN: the punch can still be saved for later. The till
	 * greets the person if it has seen their PIN online, and says plainly when
	 * it cannot tell whose PIN it is.
	 */
	const goOffline = useCallback(
		async (pin: string, why: 'offline' | 'unavailable' = 'offline') => {
			setOfflineReason(why)
			const found = await findClockPerson(pin).catch(() => ({ person: null }))
			// Too many PINs the till could not place: it stops putting names to PINs
			// for a while, but the punch is still saved (and checked when sent).
			setOfflineWho('wait' in found ? null : found.person)
			dispatch({ type: 'offline' })
		},
		[],
	)

	const submitPin = useCallback(async () => {
		if (flow.screen !== 'pin' || busyRef.current || flow.pin.length < 4) return
		if (flow.pausedUntil !== null) return
		const { pin } = flow
		busyRef.current = true
		setBusy(true)
		try {
			if (!online) {
				await goOffline(pin)
				return
			}
			// Punches saved during an outage go first, so the state shown is current,
			// but nobody waits more than a few seconds for that.
			let stillWaiting = false
			if (waiting > 0) {
				await Promise.race([
					flushPunches(settings, online).catch(() => null),
					new Promise((resolve) => window.setTimeout(resolve, 3_000)),
				])
				const queue = punchQueue()
				stillWaiting =
					queue.supported &&
					(await queue.counts().catch(() => ({ queued: 0 }))).queued > 0
				refreshWaiting()
			}
			setBehind(stillWaiting)
			const who = await api.identify(pin)
			void rememberClockPerson(pin, who).catch(() => {})
			dispatch({ type: 'identified', who })
		} catch (error) {
			if (error instanceof ClockNetworkError) await goOffline(pin)
			else if (worthSavingForLater(error)) await goOffline(pin, 'unavailable')
			else {
				if (error instanceof ClockApiError && error.code === 'invalid_pin')
					void forgetClockPin(pin).catch(() => {})
				reject(error)
			}
		} finally {
			busyRef.current = false
			setBusy(false)
		}
	}, [flow, online, api, reject, goOffline, waiting, settings, refreshWaiting])

	/**
	 * Sends a punch. Its id is made once and reused if the answer is lost, so a
	 * retry (now or from the queue) never records the same punch twice.
	 */
	const punch = useCallback(
		async (
			event: ClockEvent,
			extras: {
				positionId?: string
				cashTipsMinor?: number
				breakKind?: 'meal' | 'rest'
			} = {},
		) => {
			if (flow.screen === 'pin' || flow.screen === 'done') return
			if (flow.screen === 'people' || busyRef.current) return
			const { pin } = flow
			const firstName =
				flow.screen === 'offline'
					? (offlineWho?.firstName ?? '')
					: flow.who.firstName
			// Whose punch it is, when the till knows: never recorded for someone else.
			const staffId =
				flow.screen === 'offline' ? offlineWho?.staffId : flow.who.staffId
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
				...(extras.breakKind ? { breakKind: extras.breakKind } : {}),
				...(staffId ? { staffId } : {}),
				// A saved punch counts at the time it was tapped, in the server's time.
				clientAt: Math.round(serverNow(tappedAt)),
			}
			const saveForLater = async () => {
				await punchQueue().enqueue({
					...body,
					...(firstName ? { firstName } : {}),
					createdAt: tappedAt,
				})
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
				if (error instanceof ClockNetworkError || worthSavingForLater(error)) {
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
		[flow, api, reject, refreshWaiting, offlineWho],
	)

	const choose = (event: ClockEvent) => {
		if (flow.screen !== 'actions') return void punch(event)
		if (event === 'break_start' && flow.who.breakKinds.length > 1)
			return setPickingBreak(true)
		const step = nextStepFor(flow, event)
		if (step === 'role') dispatch({ type: 'chooseRole' })
		else if (step === 'tips') dispatch({ type: 'chooseTips', positionId: null })
		else void punch(event)
	}

	return (
		<div
			ref={rootRef}
			// Focusable, so a USB keypad or badge reader keeps typing PINs after each person.
			tabIndex={-1}
			className="bg-background flex min-h-0 flex-1 flex-col outline-none"
			onPointerDown={() => setTouched((n) => n + 1)}
			onKeyDown={(event) => {
				setTouched((n) => n + 1)
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
				timeZone={timeZone}
				waiting={waiting}
				failed={failed}
				onFailed={() => setFailedOpen(true)}
				online={online}
				onClose={onClose}
			/>
			<FailedPunches
				open={failedOpen}
				timeZone={timeZone}
				onClose={() => setFailedOpen(false)}
				onCleared={() => {
					setFailedOpen(false)
					refreshWaiting()
				}}
			/>
			<section
				aria-label={_(msg`Time clock`)}
				className="flex min-h-0 min-w-0 flex-1 items-start justify-center overflow-y-auto p-5 sm:p-8"
			>
				<div
					// Grid-overlaid pages keep their real height, including long notices.
					className="t-page-slide station-clock-pages my-auto w-full max-w-sm"
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
						ref={pageTwoRef}
						className="t-page"
						data-page-id="2"
						inert={flow.screen === 'pin'}
					>
						{flow.screen !== 'pin' && flow.screen !== 'people' ? (
							<Stagger
								replay={`${flow.screen}${pickingBreak ? ':break' : ''}${flow.screen === 'offline' ? `:${offlineStep}` : ''}`}
								className="flex h-full flex-col gap-5"
							>
								{flow.screen === 'actions' && pickingBreak ? (
									<BreakPick
										kinds={flow.who.breakKinds}
										busy={busy}
										onPick={(breakKind) =>
											void punch('break_start', { breakKind })
										}
										onBack={() => setPickingBreak(false)}
									/>
								) : flow.screen === 'actions' ? (
									<Actions
										flow={flow}
										behind={behind}
										busy={busy}
										onChoose={choose}
										onBack={reset}
										locale={i18n.locale}
										timeZone={timeZone}
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
										who={offlineWho}
										reason={offlineReason}
										busy={busy}
										locale={i18n.locale}
										currency={currency}
										onStep={setOfflineStep}
										onChoose={(event, extras) => void punch(event, extras)}
										onBack={reset}
									/>
								) : flow.screen === 'done' ? (
									<Done
										done={flow.done}
										timeZone={timeZone}
										onFinish={onClose ?? reset}
									/>
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
	timeZone,
	waiting,
	failed,
	onFailed,
	online,
	onClose,
}: {
	businessName: string
	locationName: string | null
	timeZone?: string
	waiting: number
	failed: number
	onFailed: () => void
	online: boolean
	onClose?: () => void
}) {
	const { i18n } = useLingui()
	const skewMs = useClock((s) => s.skewMs)
	// The face shows the server's time, which is the time punches count at.
	const [now, setNow] = useState(() => new Date(serverNow()))
	useEffect(() => {
		const timer = window.setInterval(() => setNow(new Date(serverNow())), 1000)
		return () => window.clearInterval(timer)
	}, [])
	// The till's clock may be off; punches then count at the server's time.
	const skewed = clockIsOff(skewMs)
	// The digits carry the screen; "AM" and "PM" sit beside them, smaller.
	const parts = new Intl.DateTimeFormat(i18n.locale, {
		hour: 'numeric',
		minute: '2-digit',
		timeZone,
	}).formatToParts(now)
	const period = parts.find((part) => part.type === 'dayPeriod')?.value ?? ''
	const time = parts
		.filter((part) => part.type !== 'dayPeriod')
		.map((part) => part.value)
		.join('')
		.trim()
	const date = new Intl.DateTimeFormat(i18n.locale, {
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		timeZone,
	}).format(now)
	return (
		<aside className="border-border flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-6">
			<div className="flex min-w-0 flex-wrap items-center gap-3">
				<div className={onClose ? 'min-w-0' : 'sr-only'}>
					<p className="truncate text-sm font-medium">{businessName}</p>
					{locationName ? (
						<p className="text-muted-foreground truncate text-sm">
							{locationName}
						</p>
					) : null}
				</div>
				{onClose ? (
					<Button
						variant="outline"
						onClick={onClose}
						className="h-auto min-h-11 shrink-0 px-3 py-2"
					>
						<Icon
							name="arrow-left"
							className="size-4 shrink-0 rtl:rotate-180"
						/>
						<Trans>Back to sign in</Trans>
					</Button>
				) : null}
			</div>
			<div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-6 gap-y-2">
				<div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
					{/* Only the digits run left to right; the day period follows the page
					    (after the time in English, before it reading Arabic). */}
					<p className="flex flex-wrap items-baseline gap-2" aria-live="off">
						<span dir="ltr" className="tnum text-xl leading-none font-medium">
							<NumberPop value={time} />
						</span>
						{period ? (
							<span className="text-muted-foreground text-sm">{period}</span>
						) : null}
					</p>
					<p className="text-muted-foreground text-sm">{date}</p>
				</div>
				<div className="flex max-w-full flex-col items-start gap-2">
					{waiting > 0 ? (
						<p className="notice-warning inline-flex items-center gap-2 rounded-(--station-control-radius) px-3 py-2 text-sm">
							<Icon name="cloud-off" className="size-4 shrink-0" />
							{plural(waiting, {
								one: '# punch waiting to send',
								other: '# punches waiting to send',
							})}
						</p>
					) : null}
					{failed > 0 ? (
						<button
							type="button"
							onClick={onFailed}
							className="notice-danger inline-flex min-h-11 items-center gap-2 rounded-(--station-control-radius) px-3 py-2 text-start text-sm transition-colors"
						>
							<Icon name="circle-alert" className="size-4 shrink-0" />
							{plural(failed, {
								one: '# punch not recorded',
								other: '# punches not recorded',
							})}
						</button>
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
		<div className="flex h-full flex-col gap-4">
			<div className="text-center">
				<h2 className="text-xl leading-tight font-semibold">
					<Trans>Enter your PIN</Trans>
				</h2>
				<p className="text-muted-foreground mt-2">
					<Trans>To clock in, take a break or clock out.</Trans>
				</p>
			</div>
			<PinDots length={flow.pin.length} rejected={rejected} />
			<div className="min-h-6 text-center">
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
						<Icon name="cloud-off" className="size-4" />
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

function BackLink({
	onBack,
	back = false,
}: {
	onBack: () => void
	/** One step back within the same person's screens, not "this is not me". */
	back?: boolean
}) {
	return (
		<button
			type="button"
			onClick={onBack}
			data-back
			className="text-muted-foreground hover:text-foreground -ms-2 inline-flex h-11 items-center gap-1.5 self-start rounded-(--station-control-radius) px-2 text-sm font-medium transition-colors"
		>
			<Icon name="arrow-left" className="size-4 rtl:rotate-180" />
			{back ? <Trans>Back</Trans> : <Trans>Not me</Trans>}
		</button>
	)
}

function EventTile({
	event,
	primary,
	busy,
	onChoose,
	wide = false,
}: {
	event: ClockEvent
	primary: boolean
	busy: boolean
	onChoose: (event: ClockEvent) => void
	/** The only choice: it takes the whole row. */
	wide?: boolean
}) {
	const { _ } = useLingui()
	const icon = EVENT_ICON[event]
	return (
		<Button
			type="button"
			variant={primary ? 'primary' : 'ghost'}
			disabled={busy}
			data-autofocus={primary || undefined}
			onClick={() => onChoose(event)}
			className={cn(
				'h-auto min-h-16 justify-start gap-3 px-4 py-3 text-start',
				wide && 'col-span-2',
			)}
		>
			<Icon name={icon} className="size-5" aria-hidden />
			<span className="text-base font-medium">{_(EVENT_LABEL[event])}</span>
		</Button>
	)
}

function Actions({
	flow,
	behind,
	busy,
	onChoose,
	onBack,
	locale,
	timeZone,
}: {
	flow: Extract<Flow, { screen: 'actions' }>
	/** Punches saved earlier on this till have not gone out yet. */
	behind: boolean
	busy: boolean
	onChoose: (event: ClockEvent) => void
	onBack: () => void
	locale: string
	timeZone?: string
}) {
	const { _ } = useLingui()
	const { who } = flow
	const shiftTime = new Intl.DateTimeFormat(locale, {
		weekday: 'short',
		hour: 'numeric',
		minute: '2-digit',
		timeZone,
	})
	const endTime = new Intl.DateTimeFormat(locale, {
		hour: 'numeric',
		minute: '2-digit',
		timeZone,
	})
	return (
		<>
			<BackLink onBack={onBack} />
			<div>
				<h2 className="t-stagger-line text-xl font-semibold">
					<Trans>Hi {who.firstName}</Trans>
				</h2>
				<p className="t-stagger-line t-stagger-line--2 text-muted-foreground mt-1 text-base">
					{_(STATE_LINE[who.state])}
				</p>
			</div>
			{behind ? (
				<p className="t-stagger-line t-stagger-line--2 notice-warning flex items-start gap-2 rounded-(--station-control-radius) px-3 py-2 text-sm">
					<Icon
						name="cloud-off"
						className="mt-0.5 size-4 shrink-0 self-start"
					/>
					<Trans>
						Punches saved on this terminal have not gone out yet, so this may be
						out of date. If you already punched here, ask a manager before
						punching again.
					</Trans>
				</p>
			) : null}
			{who.allowedEvents.length > 0 ? (
				<div className="t-stagger-line t-stagger-line--3 grid grid-cols-2 gap-3">
					{who.allowedEvents.map((event, index) => (
						<EventTile
							key={event}
							event={event}
							primary={index === 0}
							busy={busy}
							onChoose={onChoose}
							wide={who.allowedEvents.length === 1}
						/>
					))}
				</div>
			) : (
				<p className="t-stagger-line t-stagger-line--3 text-muted-foreground">
					<Trans>There is nothing to punch right now. Ask a manager.</Trans>
				</p>
			)}
			{who.nextShifts.length > 0 ? (
				<div className="t-stagger-line t-stagger-line--3 border-border border-t pt-4">
					<p className="text-muted-foreground flex items-center gap-2 text-sm font-medium">
						<Icon name="calendar-clock" className="size-4" />
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
			<h2 className="t-stagger-line text-xl font-semibold">
				<Trans>What are you working today?</Trans>
			</h2>
			<div className="t-stagger-line t-stagger-line--2 flex flex-col gap-2">
				{flow.who.positions.map((position, index) => (
					<Button
						key={position.id}
						data-autofocus={index === 0 || undefined}
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
				<h2 className="t-stagger-line text-xl font-semibold">
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
				aria-label={_(msg`Cash tips ${amount}`)}
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
				<Button
					variant="outline"
					size="lg"
					disabled={busy}
					onClick={onSkip}
					data-autofocus
				>
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
	who,
	reason,
	busy,
	locale,
	currency,
	onStep,
	onChoose,
	onBack,
}: {
	/** The person this PIN belonged to when the till last saw it online. */
	who: ClockPerson | null
	/** No connection at all, or the server cannot judge punches right now (an outage or a pause). */
	reason: 'offline' | 'unavailable'
	busy: boolean
	locale: string
	currency: string
	onStep: (step: 'actions' | 'role' | 'break' | 'tips') => void
	onChoose: (
		event: ClockEvent,
		extras?: {
			positionId?: string
			breakKind?: 'meal' | 'rest'
			cashTipsMinor?: number
		},
	) => void
	onBack: () => void
}) {
	const [pickRole, setPickRole] = useState(false)
	const [pickBreak, setPickBreak] = useState(false)
	const [declareTips, setDeclareTips] = useState(false)
	const positions = who?.positions ?? []
	const breakKinds = who?.breakKinds ?? []
	const step = declareTips
		? 'tips'
		: pickBreak
			? 'break'
			: pickRole
				? 'role'
				: 'actions'
	useEffect(() => {
		onStep(step)
		return () => onStep('actions')
	}, [step, onStep])
	// Cash tips are declared at clock-out, connection or not.
	if (declareTips)
		return (
			<Tips
				currency={currency}
				busy={busy}
				onSkip={() => onChoose('clock_out')}
				onDeclare={(cashTipsMinor) => onChoose('clock_out', { cashTipsMinor })}
				onBack={() => setDeclareTips(false)}
			/>
		)
	if (pickBreak)
		return (
			<BreakPick
				kinds={breakKinds}
				busy={busy}
				onPick={(breakKind) => onChoose('break_start', { breakKind })}
				onBack={() => setPickBreak(false)}
			/>
		)
	if (pickRole)
		return (
			<>
				<BackLink back onBack={() => setPickRole(false)} />
				<h2 className="t-stagger-line text-xl font-semibold">
					<Trans>What are you working today?</Trans>
				</h2>
				<div className="t-stagger-line t-stagger-line--2 flex flex-col gap-2">
					{positions.map((position, index) => (
						<Button
							key={position.id}
							data-autofocus={index === 0 || undefined}
							variant="outline"
							size="lg"
							disabled={busy}
							className="justify-start"
							onClick={() => onChoose('clock_in', { positionId: position.id })}
						>
							{locale === 'ar' && position.nameAr
								? position.nameAr
								: position.name}
						</Button>
					))}
				</div>
			</>
		)
	const firstName = who?.firstName ?? ''
	return (
		<>
			<BackLink onBack={onBack} />
			<div>
				<h2 className="t-stagger-line text-xl font-semibold">
					{who ? (
						<Trans>Hi {firstName}, what are you doing?</Trans>
					) : (
						<Trans>What are you doing?</Trans>
					)}
				</h2>
				<p className="t-stagger-line t-stagger-line--2 text-muted-foreground mt-1 flex items-start gap-2">
					<Icon name="cloud-off" className="mt-1 size-4 shrink-0 self-start" />
					{reason === 'unavailable' ? (
						who ? (
							<Trans>
								The time clock cannot check punches right now. Your punch is
								saved on this terminal and sent as soon as it can; your PIN is
								checked then.
							</Trans>
						) : (
							<Trans>
								The time clock cannot check punches right now, and this terminal
								does not know this PIN. Make sure it is yours: the punch is
								saved, sent and checked as soon as it can be.
							</Trans>
						)
					) : who ? (
						<Trans>
							No connection. Your punch is saved on this terminal and sent when
							it is back; your PIN is checked then.
						</Trans>
					) : (
						<Trans>
							No connection, and this terminal has not seen this PIN before, so
							it cannot check it now. Make sure it is yours: the punch is sent,
							and checked, when the connection is back.
						</Trans>
					)}
				</p>
			</div>
			<div className="t-stagger-line t-stagger-line--3 grid grid-cols-2 gap-3">
				{ALL_EVENTS.map((event, index) => (
					<EventTile
						key={event}
						event={event}
						primary={index === 0}
						busy={busy}
						onChoose={(chosen) =>
							chosen === 'clock_in' && positions.length > 1
								? setPickRole(true)
								: chosen === 'break_start' && breakKinds.length > 1
									? setPickBreak(true)
									: chosen === 'clock_out' && who?.promptTips
										? setDeclareTips(true)
										: onChoose(chosen)
						}
					/>
				))}
			</div>
		</>
	)
}

function BreakPick({
	kinds,
	busy,
	onPick,
	onBack,
}: {
	kinds: Array<'meal' | 'rest'>
	busy: boolean
	onPick: (kind: 'meal' | 'rest') => void
	onBack: () => void
}) {
	const { _ } = useLingui()
	return (
		<>
			<BackLink back onBack={onBack} />
			<h2 className="t-stagger-line text-xl font-semibold">
				<Trans>Which break are you taking?</Trans>
			</h2>
			<div className="t-stagger-line t-stagger-line--2 grid grid-cols-2 gap-3">
				{kinds.map((kind, index) => (
					<Button
						key={kind}
						type="button"
						variant={index === 0 ? 'primary' : 'ghost'}
						disabled={busy}
						data-autofocus={index === 0 || undefined}
						onClick={() => onPick(kind)}
						className={cn(
							'h-auto min-h-16 justify-start gap-3 px-4 py-3 text-start',
						)}
					>
						<Icon name="coffee" className="size-5" aria-hidden />
						<span className="text-base font-medium">
							{_(BREAK_LABEL[kind])}
						</span>
					</Button>
				))}
			</div>
		</>
	)
}

/**
 * Punches the server refused after they were saved offline (a wrong PIN, out of
 * order). Nothing was recorded for them: the person, or a manager, adds them by
 * hand. Seeing the list clears it.
 */
function FailedPunches({
	open,
	timeZone,
	onClose,
	onCleared,
}: {
	open: boolean
	timeZone?: string
	onClose: () => void
	onCleared: () => void
}) {
	const { _, i18n } = useLingui()
	const [rows, setRows] = useState<
		Array<{
			id: string
			kind: ClockEvent
			firstName?: string
			clientAt: number
			failure?: string
		}>
	>([])
	const [armed, setArmed] = useState(false)
	useEffect(() => {
		if (!armed) return
		const timer = window.setTimeout(() => setArmed(false), 4000)
		return () => window.clearTimeout(timer)
	}, [armed])
	useEffect(() => {
		setArmed(false)
		if (!open) return
		// Kept current while open: a sync may refuse another punch meanwhile.
		const load = () =>
			void punchQueue()
				.failed()
				.then(setRows, () => setRows([]))
		load()
		const timer = window.setInterval(load, 5_000)
		return () => window.clearInterval(timer)
	}, [open])
	const time = new Intl.DateTimeFormat(i18n.locale, {
		weekday: 'short',
		hour: 'numeric',
		minute: '2-digit',
		timeZone,
	})
	return (
		<Modal
			open={open}
			onClose={onClose}
			title={_(msg`Punches not recorded`)}
			footer={
				<div className="grid grid-cols-2 gap-3">
					<Button variant="outline" size="lg" onClick={onClose}>
						<Trans>Close</Trans>
					</Button>
					<Button
						variant={armed ? 'danger' : 'primary'}
						size="lg"
						onClick={() => {
							// Two taps: the list is the only record of these until a manager adds them.
							if (!armed) return setArmed(true)
							setArmed(false)
							void punchQueue()
								.clearFailed(rows.map((row) => row.id))
								.finally(onCleared)
						}}
					>
						{armed ? (
							<Trans>Tap again to clear</Trans>
						) : (
							<Trans>A manager has these, clear</Trans>
						)}
					</Button>
				</div>
			}
		>
			<div className="flex flex-col gap-3 p-5">
				<p className="text-muted-foreground">
					<Trans>
						These were saved while offline, and the server did not accept them.
						Tell a manager so they can add the right times.
					</Trans>
				</p>
				<ul className="divide-border divide-y">
					{rows.map((row) => {
						const who = row.firstName ?? ''
						const what = _(EVENT_LABEL[row.kind])
						return (
							<li key={row.id} className="flex flex-col gap-0.5 py-3">
								<span className="font-semibold">
									{who ? (
										<Trans>
											{what} · {who}
										</Trans>
									) : (
										what
									)}
								</span>
								<span className="text-muted-foreground tnum text-sm">
									{time.format(row.clientAt)}
								</span>
								<span className="text-destructive text-sm">
									{_(clockNotice(row.failure ?? 'unknown').message)}
								</span>
							</li>
						)
					})}
				</ul>
			</div>
		</Modal>
	)
}

function Done({
	done,
	timeZone,
	onFinish,
}: {
	done: Extract<Flow, { screen: 'done' }>['done']
	timeZone?: string
	onFinish: () => void
}) {
	const { _, i18n } = useLingui()
	const at =
		done.at === null
			? null
			: new Intl.DateTimeFormat(i18n.locale, {
					hour: 'numeric',
					minute: '2-digit',
					timeZone,
				}).format(done.at)
	const label = _(EVENT_DONE[done.kind])
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
			<SuccessMark tone={done.queued ? 'muted' : 'success'} size="lg" />
			<h2 className="t-stagger-line text-xl font-semibold">
				{done.firstName ? (
					<Trans>
						{label}, {done.firstName}
					</Trans>
				) : (
					label
				)}
			</h2>
			<p className="t-stagger-line t-stagger-line--2 text-muted-foreground text-base">
				{done.queued ? (
					<Trans>
						Saved on this terminal. It is sent as soon as it can be.
					</Trans>
				) : at ? (
					<Trans>Recorded at {at}.</Trans>
				) : null}
			</p>
			<Button
				variant="outline"
				size="lg"
				data-autofocus
				className="mt-2"
				onClick={onFinish}
			>
				<Trans>Done</Trans>
			</Button>
		</div>
	)
}
