import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type ReactNode } from 'react'
import { Keypad } from './Keypad.tsx'
import { PinDots } from './PinDots.tsx'
import { Button } from './primitives.tsx'

/**
 * A manager's PIN, typed on the keypad or a hardware keyboard (digits,
 * Backspace, Enter), as on the lock screen. Keys are taken while focus is
 * anywhere in the pad; the pad itself can take focus, so a keyboard user can
 * tab to it and type.
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
	return (
		<div
			role="group"
			aria-label={_(t`Manager PIN`)}
			tabIndex={0}
			onKeyDown={(event) => {
				// Typing in a field elsewhere in the sheet never lands here.
				if (event.target instanceof HTMLInputElement) return
				if (busy) return
				if (/^\d$/.test(event.key)) {
					event.preventDefault()
					if (pin.length < 6) onPin(pin + event.key)
				} else if (event.key === 'Backspace') {
					event.preventDefault()
					onPin(pin.slice(0, -1))
				} else if (event.key === 'Enter') {
					event.preventDefault()
					if (canApprove) onApprove()
				}
			}}
			className="border-border focus-visible:ring-ring space-y-2 rounded-2xl border p-3 outline-none focus-visible:ring-2"
		>
			<p className="text-sm font-semibold">{prompt}</p>
			<PinDots length={pin.length} size="sm" />
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
