'use client'

import { type Variants, motion } from 'motion/react'
import { type AnimatedIconHandle, createAnimatedIcon } from './animated-icon'

export type ShieldCheckIconHandle = AnimatedIconHandle

const CHECK_VARIANTS: Variants = {
	normal: {
		opacity: 1,
		pathLength: 1,
		scale: 1,
		transition: { duration: 0.3, opacity: { duration: 0.1 } },
	},
	animate: {
		opacity: [0, 1],
		pathLength: [0, 1],
		scale: [0.5, 1],
		transition: { duration: 0.4, opacity: { duration: 0.1 } },
	},
}

/** Hugeicons `security-check`: the check mark is drawn on the shield. */
export const ShieldCheckIcon = createAnimatedIcon(
	'ShieldCheckIcon',
	(controls) => (
		<>
			<path d="M18.7088 3.49534C16.8165 2.55382 14.5009 2 12 2C9.4991 2 7.1835 2.55382 5.29116 3.49534C4.36318 3.95706 3.89919 4.18792 3.4496 4.91378C3 5.63965 3 6.34248 3 7.74814V11.2371C3 16.9205 7.54236 20.0804 10.173 21.4338C10.9067 21.8113 11.2735 22 12 22C12.7265 22 13.0933 21.8113 13.8269 21.4338C16.4576 20.0804 21 16.9205 21 11.2371L21 7.74814C21 6.34249 21 5.63966 20.5504 4.91378C20.1008 4.18791 19.6368 3.95706 18.7088 3.49534Z" />
			<motion.path
				d="M9 11.5C9 11.5 10.4079 11.7519 11 13.5C11 13.5 12.5 10.5 15 9.5"
				initial="normal"
				variants={CHECK_VARIANTS}
				animate={controls}
			/>
		</>
	),
)
