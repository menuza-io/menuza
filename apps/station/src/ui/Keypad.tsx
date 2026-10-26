import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import { useEffect, useRef } from 'react'
import { Button, cn } from './primitives.tsx'

/**
 * Numeric keypad that edits a string of digits. `cents` mode treats the digits
 * as cents, so 1-2-5-0 reads 12.50 and no decimal key is needed.
 */
export function Keypad({
	value,
	onChange,
	maxDigits = 8,
	raw = false,
	keyboard = false,
}: {
	value: string
	onChange: (next: string) => void
	maxDigits?: number
	/** Keep leading zeros (a PIN such as 0123). Amounts drop them, so the default does. */
	raw?: boolean
	/**
	 * A hardware keyboard types into it too (digits, Backspace, Delete to clear),
	 * unless a text field has the focus. Off where the screen handles keys itself.
	 */
	keyboard?: boolean
}) {
	const { _ } = useLingui()
	const press = (key: string) => {
		if (key === 'back') return onChange(value.slice(0, -1))
		if (key === 'clear') return onChange('')
		const next = raw ? value + key : (value + key).replace(/^0+(?=\d)/, '')
		if (next.length <= maxDigits) onChange(next)
	}
	const group = useRef<HTMLDivElement>(null)
	const pressed = useRef(press)
	pressed.current = press
	useEffect(() => {
		if (!keyboard) return
		const onKey = (event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey
			)
				return
			const target = event.target as HTMLElement | null
			if (target?.closest('input, textarea, select, [contenteditable="true"]'))
				return
			// Only the keypad in use: not one behind a lock or a closing sheet (they are inert).
			const el = group.current
			if (!el || el.closest('[inert]')) return
			// Another sheet opened over this one has the keys.
			const sheet = target?.closest('dialog')
			if (sheet && !sheet.contains(el)) return
			if (/^\d$/.test(event.key)) pressed.current(event.key)
			else if (event.key === 'Backspace') pressed.current('back')
			else if (event.key === 'Delete') pressed.current('clear')
			else return
			event.preventDefault()
		}
		document.addEventListener('keydown', onKey)
		return () => document.removeEventListener('keydown', onKey)
	}, [keyboard])
	const keys = [
		'1',
		'2',
		'3',
		'4',
		'5',
		'6',
		'7',
		'8',
		'9',
		'clear',
		'0',
		'back',
	]
	return (
		// Digits keep their phone layout (1 2 3 left to right) in Arabic too.
		<div
			ref={group}
			className="grid grid-cols-3 gap-2"
			role="group"
			aria-label={_(t`Keypad`)}
			dir="ltr"
		>
			{keys.map((key) => (
				<Button
					key={key}
					type="button"
					variant={key === 'clear' || key === 'back' ? 'ghost' : 'secondary'}
					onClick={() => press(key)}
					aria-label={
						key === 'back' ? _(t`Delete`) : key === 'clear' ? _(t`Clear`) : key
					}
					className={cn(
						'h-16 min-w-0 text-2xl font-medium tabular-nums',
						// Touch has no hover: the pressed key darkens under the finger.
						key === 'clear' || key === 'back'
							? 'text-muted-foreground'
							: 'bg-secondary/60',
					)}
				>
					{key === 'back' ? (
						<Icon name="delete" className="mx-auto size-6" />
					) : key === 'clear' ? (
						<span className="text-base">C</span>
					) : (
						key
					)}
				</Button>
			))}
		</div>
	)
}
