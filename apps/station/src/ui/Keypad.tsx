import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Delete } from 'lucide-react'
import { cn } from './primitives.tsx'

/**
 * Numeric keypad that edits a string of digits. `cents` mode treats the digits
 * as cents, so 1-2-5-0 reads 12.50 and no decimal key is needed.
 */
export function Keypad({
	value,
	onChange,
	maxDigits = 8,
	raw = false,
}: {
	value: string
	onChange: (next: string) => void
	maxDigits?: number
	/** Keep leading zeros (a PIN such as 0123). Amounts drop them, so the default does. */
	raw?: boolean
}) {
	const { _ } = useLingui()
	const press = (key: string) => {
		if (key === 'back') return onChange(value.slice(0, -1))
		if (key === 'clear') return onChange('')
		const next = raw ? value + key : (value + key).replace(/^0+(?=\d)/, '')
		if (next.length <= maxDigits) onChange(next)
	}
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
			className="grid grid-cols-3 gap-2"
			role="group"
			aria-label={_(t`Keypad`)}
			dir="ltr"
		>
			{keys.map((key) => (
				<button
					key={key}
					type="button"
					onClick={() => press(key)}
					aria-label={
						key === 'back' ? _(t`Delete`) : key === 'clear' ? _(t`Clear`) : key
					}
					className={cn(
						'tnum mono h-16 rounded-xl text-2xl font-semibold transition active:scale-95',
						// Touch has no hover: the pressed key darkens under the finger.
						key === 'clear' || key === 'back'
							? 'bg-muted text-muted-foreground hover:bg-accent active:bg-accent'
							: 'border-border bg-card hover:bg-accent active:bg-accent border',
					)}
				>
					{key === 'back' ? (
						<Delete className="mx-auto size-6" />
					) : key === 'clear' ? (
						<span className="text-base">C</span>
					) : (
						key
					)}
				</button>
			))}
		</div>
	)
}
