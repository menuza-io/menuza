import { Trans } from '@lingui/macro'
import { type ClockEvent } from '@repo/staffing'
import { Skeleton } from '@repo/ui/skeleton'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import {
	ConnectionPill,
	FailedPunchesDialog,
	KioskClock,
	LanguageToggle,
} from '#app/components/kiosk/kiosk-chrome.tsx'
import { KioskUnpaired } from '#app/components/kiosk/kiosk-pair.tsx'
import {
	ActionsScreen,
	DoneScreen,
	OfflineScreen,
	PeopleScreen,
	PinScreen,
	RoleScreen,
	TipsScreen,
} from '#app/components/kiosk/kiosk-screens.tsx'
import { useKioskLocale } from '#app/hooks/use-kiosk-locale.ts'
import {
	useKioskRuntime,
	type KioskRuntime,
	type TenantApiUrls,
} from '#app/hooks/use-kiosk-runtime.ts'
import {
	KioskApiError,
	KioskNetworkError,
	type KioskPersonView,
} from '#app/utils/kiosk/kiosk-api.ts'
import { type KioskLocale } from '#app/utils/kiosk/kiosk-device.ts'
import {
	amountToMinor,
	flowReducer,
	IDLE_SECONDS,
	nextStepFor,
	startFlow,
	type Notice,
} from '#app/utils/kiosk/kiosk-flow.ts'
import {
	type QueuedPunch,
	QueueUnavailableError,
} from '#app/utils/kiosk/kiosk-queue.ts'

/** Seconds the confirmation stays up before the tablet returns to the PIN pad. */
const DONE_SECONDS = 5
/** A half-typed PIN is cleared if nobody finishes it. */
const PIN_IDLE_SECONDS = 30

/**
 * The shared-tablet time clock. Client-only: nothing on the server renders or
 * loads a person. The page shell is cached by a service worker, the pairing and
 * language live on the tablet, and punches made without a connection wait in an
 * on-device queue (see `kiosk-queue.ts`).
 */
export function KioskApp({ urls }: { urls: TenantApiUrls }) {
	const runtime = useKioskRuntime(urls)
	const [locale, changeLocale] = useKioskLocale()

	if (!runtime.hydrated) {
		return (
			<div
				role="status"
				aria-busy="true"
				className="flex flex-1 flex-col gap-4 p-6"
			>
				<span className="sr-only">
					<Trans>Loading the time clock</Trans>
				</span>
				<Skeleton className="h-16 w-64" />
				<Skeleton className="h-full w-full" />
			</div>
		)
	}

	if (!runtime.device) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<header className="flex justify-end px-4 py-2 md:px-6">
					<LanguageToggle locale={locale} onChange={changeLocale} />
				</header>
				<main
					id="main-content"
					className="flex min-h-0 flex-1 flex-col overflow-y-auto"
				>
					<KioskUnpaired removed={runtime.removed} onPair={runtime.pair} />
				</main>
			</div>
		)
	}

	return (
		<KioskReady
			runtime={runtime}
			locale={locale}
			onLocaleChange={changeLocale}
		/>
	)
}

function KioskReady({
	runtime,
	locale,
	onLocaleChange,
}: {
	runtime: KioskRuntime
	locale: KioskLocale
	onLocaleChange: (locale: KioskLocale) => void
}) {
	const device = runtime.device!
	const mode = device.config.device.identifyMode
	const timeZone = device.config.scope.timeZone
	const [flow, dispatch] = useReducer(flowReducer, mode, startFlow)
	const [busy, setBusy] = useState(false)
	const [people, setPeople] = useState<KioskPersonView[]>([])
	const [peopleLoading, setPeopleLoading] = useState(false)
	const [doneSeconds, setDoneSeconds] = useState(DONE_SECONDS)
	const [activity, setActivity] = useState(0)
	const [failed, setFailed] = useState<QueuedPunch[]>([])
	const [showFailed, setShowFailed] = useState(false)
	const busyRef = useRef(false)

	// A manager switching this tablet between PIN and pick-name takes effect now.
	const lastMode = useRef(mode)
	useEffect(() => {
		if (lastMode.current !== mode) {
			lastMode.current = mode
			dispatch({ type: 'reset', mode })
		}
	}, [mode])

	// Any touch or key counts as activity and restarts the idle timer.
	useEffect(() => {
		function bump() {
			setActivity((value) => value + 1)
		}
		window.addEventListener('pointerdown', bump, { passive: true })
		window.addEventListener('keydown', bump)
		return () => {
			window.removeEventListener('pointerdown', bump)
			window.removeEventListener('keydown', bump)
		}
	}, [])

	// Idle: step back to the start so nobody's PIN or name lingers on a shared screen.
	useEffect(() => {
		let seconds = IDLE_SECONDS[flow.screen]
		// A half-typed PIN, or a name picked and then abandoned, does not linger.
		if (flow.screen === 'pin' && (flow.pin.length > 0 || flow.person)) {
			seconds = PIN_IDLE_SECONDS
		}
		if (flow.screen === 'done' || seconds === null) return
		const timer = setTimeout(
			() => dispatch({ type: 'reset', mode }),
			seconds * 1000,
		)
		return () => clearTimeout(timer)
	}, [flow, activity, mode])

	// The confirmation counts down on its own and then closes.
	useEffect(() => {
		if (flow.screen !== 'done') return
		setDoneSeconds(DONE_SECONDS)
		const timer = setInterval(() => {
			setDoneSeconds((value) => {
				if (value <= 1) {
					clearInterval(timer)
					dispatch({ type: 'reset', mode })
					return 0
				}
				return value - 1
			})
		}, 1000)
		return () => clearInterval(timer)
	}, [flow.screen, mode])

	// Names for pick-name mode, refreshed whenever the list is shown.
	const { api } = runtime
	useEffect(() => {
		if (flow.screen !== 'people' || !api) return
		let live = true
		setPeopleLoading(true)
		api.people().then(
			(result) => {
				if (!live) return
				setPeople(result.people)
				setPeopleLoading(false)
				runtime.markOnline()
			},
			(error: unknown) => {
				if (!live) return
				setPeopleLoading(false)
				if (error instanceof KioskNetworkError) runtime.markOffline()
			},
		)
		return () => {
			live = false
		}
		// `runtime` methods are stable enough; only the screen and client matter.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [flow.screen, api])

	// Refused offline punches, for the "needs a manager" panel.
	useEffect(() => {
		void runtime.queue.failed().then(setFailed, () => setFailed([]))
	}, [runtime.queue, runtime.counts.failed])

	const reject = useCallback(
		(error: unknown, now = Date.now()) => {
			let notice: Notice
			if (error instanceof KioskApiError) {
				notice = {
					code: error.code,
					retryAfterSeconds: error.retryAfterSeconds || undefined,
				}
			} else if (error instanceof QueueUnavailableError) {
				notice = { code: 'queue_unavailable' }
			} else if (error instanceof KioskNetworkError) {
				notice = { code: 'network_unavailable' }
			} else {
				notice = { code: 'unknown' }
			}
			dispatch({ type: 'rejected', notice, now, mode })
		},
		[mode],
	)

	const submitPin = useCallback(async () => {
		if (flow.screen !== 'pin' || busyRef.current || flow.pin.length < 4) return
		if (!runtime.api) return
		if (
			!runtime.online &&
			typeof navigator !== 'undefined' &&
			!navigator.onLine
		) {
			dispatch({ type: 'offline' })
			return
		}
		busyRef.current = true
		setBusy(true)
		try {
			const who = await runtime.api.identify(flow.pin, flow.person?.staffId)
			runtime.noteServerTime(who.serverNow)
			runtime.markOnline()
			dispatch({ type: 'identified', who })
		} catch (error) {
			if (error instanceof KioskNetworkError) {
				runtime.markOffline()
				dispatch({ type: 'offline' })
			} else {
				reject(error)
			}
		} finally {
			busyRef.current = false
			setBusy(false)
		}
	}, [flow, runtime, reject])

	/**
	 * Sends a punch. The id is made once and reused if the first try is lost, so
	 * a retry (now or from the queue) can never record the same punch twice.
	 */
	const punch = useCallback(
		async (
			screen: 'actions' | 'role' | 'tips' | 'offline',
			event: ClockEvent,
			extras: { positionId?: string; cashTipsMinor?: number } = {},
		) => {
			if (flow.screen !== screen || busyRef.current || !runtime.api) return
			const { pin } = flow
			const person = flow.person
			const firstName =
				flow.screen === 'offline'
					? (person?.firstName ?? '')
					: flow.who.firstName
			busyRef.current = true
			setBusy(true)
			const id = crypto.randomUUID()
			const tappedAt = Date.now()
			const base = {
				id,
				kind: event,
				pin,
				...(person ? { staffId: person.staffId } : {}),
				...(extras.positionId ? { positionId: extras.positionId } : {}),
				...(extras.cashTipsMinor !== undefined
					? { cashTipsMinor: extras.cashTipsMinor }
					: {}),
				// The tap time, corrected by how far the server's clock is ahead.
				clientAt: tappedAt + runtime.serverOffset,
			}
			async function saveForLater() {
				await runtime.enqueue({
					id,
					kind: event,
					clientAt: base.clientAt,
					pin,
					...(person ? { staffId: person.staffId } : {}),
					...(extras.positionId ? { positionId: extras.positionId } : {}),
					...(extras.cashTipsMinor !== undefined
						? { cashTipsMinor: extras.cashTipsMinor }
						: {}),
					createdAt: tappedAt,
				})
				dispatch({
					type: 'done',
					done: { kind: event, firstName, at: null, queued: true },
				})
			}
			try {
				if (screen === 'offline') {
					await saveForLater()
					return
				}
				const result = await runtime.api.punch({
					...base,
					deviceNowAt: tappedAt,
					offline: false,
				})
				runtime.noteServerTime(result.serverNow)
				runtime.markOnline()
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
				if (error instanceof KioskNetworkError) {
					runtime.markOffline()
					try {
						await saveForLater()
					} catch (queueError) {
						reject(queueError)
					}
				} else if (
					error instanceof KioskApiError &&
					error.code === 'position_required' &&
					(flow.screen === 'actions' || flow.screen === 'role')
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
		[flow, runtime, reject],
	)

	const reset = useCallback(() => dispatch({ type: 'reset', mode }), [mode])

	let body: React.ReactNode
	switch (flow.screen) {
		case 'people':
			body = (
				<PeopleScreen
					people={people}
					loading={peopleLoading}
					notice={
						!peopleLoading && !runtime.online && people.length === 0
							? { code: 'network_unavailable' }
							: flow.notice
					}
					onPick={(person) =>
						dispatch({
							type: 'pickPerson',
							person: { staffId: person.staffId, firstName: person.firstName },
						})
					}
				/>
			)
			break
		case 'pin':
			body = (
				<PinScreen
					pin={flow.pin}
					personName={flow.person?.firstName ?? null}
					notice={flow.notice}
					pausedUntil={flow.pausedUntil}
					busy={busy}
					onDigit={(digit) => dispatch({ type: 'digit', digit })}
					onBackspace={() => dispatch({ type: 'backspace' })}
					onSubmit={() => void submitPin()}
					onBack={flow.person ? reset : undefined}
				/>
			)
			break
		case 'actions':
			body = (
				<ActionsScreen
					who={flow.who}
					busy={busy}
					notice={null}
					timeZone={timeZone}
					onCancel={reset}
					onChoose={(event) => {
						const step = nextStepFor(flow, event)
						if (step === 'role') dispatch({ type: 'chooseRole' })
						else if (step === 'tips') {
							dispatch({ type: 'chooseTips', positionId: null })
						} else void punch('actions', event)
					}}
				/>
			)
			break
		case 'role':
			body = (
				<RoleScreen
					who={flow.who}
					locale={locale}
					busy={busy}
					onCancel={reset}
					onPick={(positionId) =>
						void punch('role', 'clock_in', { positionId })
					}
				/>
			)
			break
		case 'tips':
			body = (
				<TipsScreen
					amount={flow.amount}
					busy={busy}
					onDigit={(digit) => dispatch({ type: 'amountDigit', digit })}
					onBackspace={() => dispatch({ type: 'amountBackspace' })}
					onSkip={() => void punch('tips', 'clock_out')}
					onSubmit={() => {
						const minor = amountToMinor(flow.amount)
						if (minor !== null) {
							void punch('tips', 'clock_out', { cashTipsMinor: minor })
						}
					}}
					onCancel={reset}
				/>
			)
			break
		case 'offline':
			body = (
				<OfflineScreen
					busy={busy}
					onCancel={reset}
					onChoose={(event) => void punch('offline', event)}
				/>
			)
			break
		case 'done':
			body = (
				<DoneScreen
					done={flow.done}
					timeZone={timeZone}
					seconds={doneSeconds}
					onDone={reset}
				/>
			)
			break
	}

	const place = [device.config.scope.name, device.config.device.name]
		.filter(Boolean)
		.join(' · ')

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 md:px-6">
				<p className="min-w-0 truncate text-lg font-medium">{place}</p>
				<div className="flex flex-wrap items-center gap-2">
					<ConnectionPill
						online={runtime.online}
						queued={runtime.counts.queued}
						failed={runtime.counts.failed}
						indicator={runtime.indicator}
						onShowFailed={() => setShowFailed(true)}
					/>
					<LanguageToggle locale={locale} onChange={onLocaleChange} />
				</div>
			</header>
			<div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4 md:px-6 md:pb-6 landscape:flex-row landscape:gap-8">
				<div className="flex shrink-0 flex-col justify-center landscape:flex-1">
					<KioskClock timeZone={timeZone} serverOffset={runtime.serverOffset} />
				</div>
				<main
					id="main-content"
					className="mx-auto flex min-h-0 w-full max-w-md flex-1 flex-col landscape:flex-1"
				>
					{body}
				</main>
			</div>
			<FailedPunchesDialog
				open={showFailed}
				items={failed}
				timeZone={timeZone}
				onClose={() => setShowFailed(false)}
				onClear={() => {
					void runtime.queue.clearFailed().then(() => runtime.refreshCounts())
					setShowFailed(false)
				}}
			/>
		</div>
	)
}
