import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Keypad } from './Keypad.tsx'
import { PinDots } from './PinDots.tsx'
import { Button } from './primitives.tsx'

/**
 * A manager's PIN, typed on the keypad or a hardware keyboard (digits,
 * Backspace, Enter), as on the lock screen. Keys are taken while the pad
 * shows, wherever the last tap was, except while a text field has the focus.
 */
export function ManagerPinPad({
	prompt,
	pin,
	onPin,
	busy,
	onApprove,
	variant = 'primary',
}: {
	prompt: ReactNode
	pin: string
	onPin: (pin: string) => void
	busy: boolean
	onApprove: () => void
	variant?: 'primary' | 'outline'
}) {
	const { _ } = useLingui()
	const canApprove = pin.length >= 4 && !busy
	// A check that ends with the pad still showing was a refusal (an approval
	// replaces the pad): shake the dots.
	const [rejected, setRejected] = useState(0)
	const [wasBusy, setWasBusy] = useState(busy)
	if (busy !== wasBusy) {
		setWasBusy(busy)
		if (!busy) setRejected((n) => n + 1)
	}
	// While it shows, a hardware keyboard types the PIN wherever the last tap was
	// (never into an amount keypad beside it). Captured first, at the document.
	const group = useRef<HTMLDivElement>(null)
	const latest = useRef({ pin, busy, canApprove, onPin, onApprove })
	latest.current = { pin, busy, canApprove, onPin, onApprove }
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey
			)
				return
			const target = event.target as HTMLElement | null
			// Typing in a field elsewhere in the sheet never lands here.
			if (target?.closest('input, textarea, select, [contenteditable="true"]'))
				return
			const el = group.current
			if (!el || el.closest('[inert]')) return
			// Another sheet opened over this one has the keys.
			const sheet = target?.closest('dialog')
			if (sheet && !sheet.contains(el)) return
			const now = latest.current
			if (/^\d$/.test(event.key)) {
				if (!now.busy && now.pin.length < 6) now.onPin(now.pin + event.key)
			} else if (event.key === 'Backspace') {
				if (!now.busy) now.onPin(now.pin.slice(0, -1))
			} else if (event.key === 'Enter') {
				// Enter on a focused button (Back, a reason) presses that button.
				if (target?.closest('button, a, [role="button"]')) return
				if (now.canApprove) now.onApprove()
			} else return
			event.preventDefault()
		}
		document.addEventListener('keydown', onKey, true)
		return () => document.removeEventListener('keydown', onKey, true)
	}, [])
	return (
		<div
			role="group"
			aria-label={_(t`Manager PIN`)}
			tabIndex={0}
			ref={group}
			className="focus-visible:ring-ring space-y-3 py-3 outline-none focus-visible:ring-2"
		>
			<p className="text-sm font-semibold">{prompt}</p>
			<PinDots length={pin.length} size="sm" rejected={rejected} />
			<Keypad
				value={pin}
				onChange={(next) => !busy && onPin(next.slice(0, 6))}
				maxDigits={6}
				raw
			/>
			<Button
				variant={variant}
				className="w-full"
				disabled={!canApprove}
				onClick={onApprove}
			>
				{busy ? <Trans>Checking…</Trans> : <Trans>Approve</Trans>}
			</Button>
		</div>
	)
}
