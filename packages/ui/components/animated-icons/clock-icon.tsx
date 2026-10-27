'use client'

import { type Variants, motion } from 'motion/react'
import { type AnimatedIconHandle, createAnimatedIcon } from './animated-icon'

export type ClockIconHandle = AnimatedIconHandle

// Each hand turns around the clock's centre, at (12, 12).
const MINUTE_HAND_VARIANTS: Variants = {
	normal: { rotate: 0, originX: '50%', originY: '100%' },
	animate: {
		rotate: 360,
		originX: '50%',
		originY: '100%',
		transition: { duration: 0.6, ease: [0.4, 0, 0.2, 1] },
	},
}

const HOUR_HAND_VARIANTS: Variants = {
	normal: { rotate: 0, originX: '0%', originY: '0%' },
	animate: {
		rotate: 45,
		originX: '0%',
		originY: '0%',
		transition: { duration: 0.5, ease: 'easeInOut' },
	},
}

/** Hugeicons `clock-01`: both hands turn around the centre. */
export const ClockIcon = createAnimatedIcon('ClockIcon', (controls) => (
	<>
		<circle cx="12" cy="12" r="10" />
		<motion.path
			d="M12 8V12"
			variants={MINUTE_HAND_VARIANTS}
			animate={controls}
		/>
		<motion.path
			d="M12 12L14 14"
			variants={HOUR_HAND_VARIANTS}
			animate={controls}
		/>
	</>
))
