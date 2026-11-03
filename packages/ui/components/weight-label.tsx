import { type CSSProperties } from 'react'

import { fontWeights } from '../lib/font-weight'
import { cn } from '../lib/utils'

/**
 * Text that gets heavier when `active` (selected, current, open) without
 * moving its neighbours. A heavier weight is wider, so an invisible copy at
 * the heaviest weight holds the width while the visible copy animates
 * `font-variation-settings`.
 *
 * The weight comes from the `fontWeights` tokens (through `--weight`), never
 * `font-weight`: the transition has to name `font-variation-settings` or the
 * weight snaps.
 */
export function WeightLabel({
	active,
	children,
	className,
}: {
	active: boolean
	children: string
	className?: string
}) {
	return (
		<span className={cn('inline-grid min-w-0', className)}>
			<span
				className="col-start-1 row-start-1 truncate transition-[color,font-variation-settings] duration-80 [font-variation-settings:var(--weight)] motion-reduce:transition-none"
				style={
					{
						'--weight': active ? fontWeights.semibold : fontWeights.normal,
					} as CSSProperties
				}
			>
				{children}
			</span>
			<span
				aria-hidden="true"
				className="invisible col-start-1 row-start-1 truncate [font-variation-settings:var(--weight)]"
				style={{ '--weight': fontWeights.semibold } as CSSProperties}
			>
				{children}
			</span>
		</span>
	)
}
