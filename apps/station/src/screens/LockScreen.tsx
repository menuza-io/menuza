import { plural, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { CloudOff, Lock } from 'lucide-react'
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
}: {
	businessName: string
	logoUrl: string | null
	online: boolean
	demo: boolean
	onSignIn: (pin: string) => Promise<SignInOutcome>
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
			setMessage(outcome.message)
			if (outcome.retryAfterSeconds) {
				const at = monotonicNow()
				setNow(at)
				setWaitUntil(at + outcome.retryAfterSeconds * 1000)
			}
		} catch {
			// Never leave the till stuck on "Checking…": say so and let them try again.
			setPin('')
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
			<div className="pt-safe mx-auto flex min-h-full w-full max-w-sm flex-col items-center justify-center gap-6 p-6">
				<div className="flex flex-col items-center gap-3 text-center">
					{logoUrl ? (
						<img
							src={logoUrl}
							alt=""
							className="size-16 rounded-2xl object-cover"
						/>
					) : (
						<div className="bg-primary text-primary-foreground flex size-16 items-center justify-center rounded-2xl text-2xl font-bold">
							{businessName.slice(0, 1).toUpperCase()}
						</div>
					)}
					<h1 className="text-xl font-bold">{businessName}</h1>
					<p className="text-muted-foreground flex items-center gap-2">
						<Lock className="size-4" /> <Trans>Enter your PIN to start</Trans>
					</p>
				</div>

				<PinDots length={pin.length} />

				<div className="min-h-12 text-center">
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
							<CloudOff className="size-4" />{' '}
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
			</div>
		</dialog>
	)
}
