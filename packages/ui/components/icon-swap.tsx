import { motion } from 'motion/react'

import { spring } from '../lib/springs'
import { cn } from '../lib/utils'
import { Icon, type IconSize } from './icon'
import { type IconName } from './icons/icon-name'

const SHOWN = { opacity: 1, scale: 1, filter: 'blur(0px)' }
const HIDDEN = { opacity: 0, scale: 0.6, filter: 'blur(4px)' }
// Tweens on purpose: a spring settles early and would invert the order (the
// arriving glyph has to outlast the leaving one), and blur is a `filter`
// string a spring can't drive.
const enter = {
	type: 'tween',
	duration: spring.fast.duration,
	ease: 'easeOut',
} as const
const leave = { type: 'tween', ...spring.fast.exit, ease: 'easeIn' } as const

/**
 * Swaps one glyph for another (copy → check, play → pause) by crossfading
 * both in a single grid cell with a touch of blur and scale, so the slot never
 * resizes and the change reads as one gesture instead of a snap.
 */
export function IconSwap({
	from,
	to,
	swapped,
	size,
	className,
}: {
	/** The glyph shown at rest. */
	from: IconName
	/** The glyph shown once `swapped`. */
	to: IconName
	swapped: boolean
	size?: IconSize
	className?: string
}) {
	return (
		<span className="inline-grid shrink-0" aria-hidden="true">
			<motion.span
				className="col-start-1 row-start-1 flex"
				initial={false}
				animate={swapped ? HIDDEN : SHOWN}
				transition={swapped ? leave : enter}
			>
				<Icon name={from} size={size} className={cn(className)} />
			</motion.span>
			<motion.span
				className="col-start-1 row-start-1 flex"
				initial={false}
				animate={swapped ? SHOWN : HIDDEN}
				transition={swapped ? enter : leave}
			>
				<Icon name={to} size={size} className={cn(className)} />
			</motion.span>
		</span>
	)
}
