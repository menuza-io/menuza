import { plural } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from './primitives.tsx'

/**
 * The dots that show how many PIN digits are in. A polite live region says the
 * count in words as it changes; the dots themselves are hidden from assistive
 * technology (they would only repeat it). Each new `rejected` count shakes the
 * row and tints it until the next digit (error state shake).
 */
export function PinDots({
	length,
	size = 'md',
	rejected = 0,
}: {
	length: number
	size?: 'sm' | 'md'
	/** Bumped each time a PIN is refused. */
	rejected?: number
}) {
	const { _ } = useLingui()
	const error = rejected > 0 && length === 0
	return (
		<div
			role="status"
			// A new key replays the shake from rest.
			key={rejected}
			className={cn(
				't-input flex min-h-6 items-center justify-center gap-3',
				rejected > 0 && 'is-shaking',
			)}
		>
			{Array.from({ length: Math.max(4, length) }, (_unused, i) => (
				<span
					key={i}
					aria-hidden
					className={cn(
						'rounded-full border-2 transition',
						size === 'sm' ? 'size-3.5' : 'size-4',
						error
							? 'border-destructive bg-destructive/10'
							: i < length
								? 'border-primary bg-primary'
								: 'border-muted-foreground/50 bg-muted',
					)}
				/>
			))}
			<span className="sr-only">
				{_(
					plural(length, {
						one: '# digit entered',
						other: '# digits entered',
					}),
				)}
			</span>
		</div>
	)
}
