'use client'

import { type Variants, motion } from 'motion/react'
import { type AnimatedIconHandle, createAnimatedIcon } from './animated-icon'

export type CircleHelpIconHandle = AnimatedIconHandle

const MARK_VARIANTS: Variants = {
	normal: { rotate: 0 },
	animate: {
		rotate: [0, -10, 10, -10, 0],
		transition: { duration: 0.5, ease: 'easeInOut' },
	},
}

/** Hugeicons `help-circle`: the question mark wiggles. */
export const CircleHelpIcon = createAnimatedIcon(
	'CircleHelpIcon',
	(controls) => (
		<>
			<circle cx="12" cy="12" r="10" />
			<motion.g variants={MARK_VARIANTS} animate={controls}>
				<path d="M9.5 9.5C9.5 8.11929 10.6193 7 12 7C13.3807 7 14.5 8.11929 14.5 9.5C14.5 10.3569 14.0689 11.1131 13.4117 11.5636C12.7283 12.0319 12 12.6716 12 13.5" />
				<path d="M12.125 16.75H12M12.25 16.75C12.25 16.8881 12.1381 17 12 17C11.8619 17 11.75 16.8881 11.75 16.75C11.75 16.6119 11.8619 16.5 12 16.5C12.1381 16.5 12.25 16.6119 12.25 16.75Z" />
			</motion.g>
		</>
	),
)
