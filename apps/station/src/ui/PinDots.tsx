import { plural } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from './primitives.tsx'

/**
 * The dots that show how many PIN digits are in. A polite live region says the
 * count in words as it changes; the dots themselves are hidden from assistive
 * technology (they would only repeat it).
 */
export function PinDots({
	length,
	size = 'md',
}: {
	length: number
	size?: 'sm' | 'md'
}) {
	const { _ } = useLingui()
	return (
		<div role="status" className="flex justify-center gap-3">
			{Array.from({ length: Math.max(4, length) }, (_unused, i) => (
				<span
					key={i}
					aria-hidden
					className={cn(
						'border-primary rounded-full border-2 transition',
						size === 'sm' ? 'size-3.5' : 'size-4',
						i < length && 'bg-primary',
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
