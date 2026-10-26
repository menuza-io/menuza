import { plural, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import { useEffect, useRef, useState } from 'react'
import { monotonicNow } from '~/lib/clock.ts'
import { DEMO_PIN, type SignInOutcome } from '~/lib/signin.ts'
import { Keypad } from '~/ui/Keypad.tsx'
import { PinDots } from '~/ui/PinDots.tsx'
import { Button } from '~/ui/primitives.tsx'

/**
 * The lock. A modal <dialog> opened last, so it covers everything, including a
 * payment sheet that was open when the till locked (those wait underneath and
 * resume after sign-in). It cannot be dismissed: only a valid PIN opens it.
 */
export function LockScreen({
	businessName,
	logoUrl,
	online,
	demo,
	onSignIn,
	onClockIn,
}: {
	businessName: string
	logoUrl: string | null
	online: boolean
	demo: boolean
	onSignIn: (pin: string) => Promise<SignInOutcome>
	/** When the terminal is a time clock too: clock in without signing in to the till. */
	onClockIn?: () => void
}) {
	const ref = useRef<HTMLDialogElement>(null)
	const { _ } = useLingui()
	const [pin, setPin] = useState('')
	const [busy, setBusy] = useState(false)
	const [message, setMessage] = useState<string | null>(null)
	/** End of a wrong-PIN wait on the monotonic clock: changing the tablet's time does not end it. */
	const [waitUntil, setWaitUntil] = useState<number | null>(null)
	const [now, setNow] = useState(() => monotonicNow())
	/** Spoken once when a wait ends (the countdown itself is not announced every second). */
	const [ready, setReady] = useState(false)
	/** Counts refusals, so the dots shake for each one. */
	const [rejected, setRejected] = useState(0)

	useEffect(() => {
		const dialog = ref.current
		if (dialog && !dialog.open) dialog.showModal()
	}, [])

	useEffect(() => {
		if (waitUntil === null) return
		const timer = setInterval(() => {
			const at = monotonicNow()
			setNow(at)
			if (at >= waitUntil) {
				setWaitUntil(null)
				setMessage(null)
				setReady(true)
			}
		}, 500)
		return () => clearInterval(timer)
	}, [waitUntil])

	const waiting = waitUntil !== null && now < waitUntil
	const secondsLeft = waiting ? Math.ceil((waitUntil - now) / 1000) : 0
	const canSubmit = pin.length >= 4 && !busy && !waiting

	const submit = async () => {
		if (!canSubmit) return
		setBusy(true)
		setMessage(null)
		setReady(false)
		try {
			const outcome = await onSignIn(pin)
			// On success the till unmounts this screen.
			if (outcome.ok) return
			setPin('')
			setRejected((n) => n + 1)
			setMessage(outcome.message)
			if (outcome.retryAfterSeconds) {
				const at = monotonicNow()
				setNow(at)
				setWaitUntil(at + outcome.retryAfterSeconds * 1000)
			}
		} catch {
			// Never leave the till stuck on "Checking…": say so and let them try again.
			setPin('')
			setRejected((n) => n + 1)
			setMessage(_(t`Could not check the PIN. Try again.`))
		} finally {
			setBusy(false)
		}
	}

	return (
		<dialog
			ref={ref}
			aria-label={_(t`Locked. Enter your PIN.`)}
			onCancel={(event) => event.preventDefault()}
			onKeyDown={(event) => {
				// While a PIN is being checked, further input is ignored rather than
				// typed into a field that is about to be cleared.
				if (busy) return
				if (/^\d$/.test(event.key))
					setPin((p) => (p.length < 6 ? p + event.key : p))
				else if (event.key === 'Backspace') setPin((p) => p.slice(0, -1))
				else if (event.key === 'Enter') void submit()
			}}
			className="bg-background text-foreground backdrop:bg-background m-0 h-dvh max-h-none w-screen max-w-none overflow-y-auto p-0"
		>
			<div className="pt-safe pb-safe mx-auto flex min-h-full w-full max-w-md flex-col items-center justify-center gap-4 px-6 py-6 sm:px-8">
				<div className="mb-2 flex w-full items-center justify-center gap-3">
					{logoUrl ? (
						<img
							src={logoUrl}
							alt=""
							className="size-10 shrink-0 rounded-(--station-panel-radius) object-contain"
						/>
					) : (
						<div
							className="bg-primary text-primary-foreground flex size-10 shrink-0 items-center justify-center rounded-(--station-panel-radius) text-base font-semibold"
							aria-hidden
						>
							{businessName.slice(0, 1).toUpperCase()}
						</div>
					)}
					<h1 className="min-w-0 text-xl leading-tight font-semibold break-words">
						{businessName}
					</h1>
				</div>

				<p className="text-muted-foreground flex items-center justify-center gap-2 text-center">
					<Icon name="lock" className="size-4 shrink-0" aria-hidden />{' '}
					<Trans>Enter your PIN to start</Trans>
				</p>
				<PinDots length={pin.length} rejected={rejected} />

				<div className="min-h-6 w-full text-center">
					{/* Announced once, when it appears; the countdown below is not live. */}
					<p
						role="alert"
						className={
							// During a wait the countdown below shows it; the alert stays for screen readers.
							waiting
								? 'sr-only'
								: 'text-destructive text-sm font-medium empty:hidden'
						}
					>
						{message}
					</p>
					{waiting ? (
						<p className="text-destructive text-sm font-medium" aria-hidden>
							{plural(secondsLeft, {
								one: 'Too many wrong PINs. Try again in # second.',
								other: 'Too many wrong PINs. Try again in # seconds.',
							})}
						</p>
					) : null}
					<p role="status" className="sr-only">
						{ready ? _(t`You can try your PIN again now.`) : ''}
					</p>
					{!message && !waiting && !online && !demo ? (
						<p className="text-muted-foreground flex items-center justify-center gap-2 text-sm">
							<Icon name="cloud-off" className="size-4" />{' '}
							<Trans>
								Offline: people who have signed in here before can still sign
								in.
							</Trans>
						</p>
					) : null}
					{demo ? (
						<p className="text-muted-foreground mt-1 text-sm">
							<Trans>Demo mode: the PIN is {DEMO_PIN}.</Trans>
						</p>
					) : null}
				</div>

				<div className="w-full">
					<Keypad
						value={pin}
						onChange={(next) => !busy && setPin(next.slice(0, 6))}
						maxDigits={6}
						raw
					/>
				</div>
				<Button
					variant="primary"
					size="xl"
					className="w-full"
					disabled={!canSubmit}
					onClick={() => void submit()}
				>
					{busy ? <Trans>Checking…</Trans> : <Trans>Sign in</Trans>}
				</Button>
				{onClockIn ? (
					<Button
						data-clock-trigger
						variant="ghost"
						size="lg"
						className="mt-1 w-full"
						onClick={onClockIn}
					>
						<Icon name="clock-3" className="size-5" />
						<Trans>Clock in or out</Trans>
					</Button>
				) : null}
			</div>
		</dialog>
	)
}
