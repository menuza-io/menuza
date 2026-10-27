'use client'

import { type Variants, motion } from 'motion/react'
import { type AnimatedIconHandle, createAnimatedIcon } from './animated-icon'

export type UserRoundPlusIconHandle = AnimatedIconHandle

const BAR_VARIANTS: Variants = {
	normal: { opacity: 1, pathLength: 1 },
	animate: (delay: number) => ({
		opacity: [0, 1],
		pathLength: [0, 1],
		transition: { delay, duration: 0.2, opacity: { duration: 0.1, delay } },
	}),
}

/** Hugeicons `user-add-01`: the plus is drawn stroke by stroke. */
export const UserRoundPlusIcon = createAnimatedIcon(
	'UserRoundPlusIcon',
	(controls) => (
		<>
			<path d="M3 20.5002C3.28417 16.8058 6.3 13.7193 10.0008 13.5379C10.3134 13.5226 10.6446 13.5097 11 13.5L11.995 13.5663C12.6939 13.6129 13.3665 13.7543 14 13.9777" />
			<circle cx="11" cy="6.5" r="4" />
			<motion.path
				d="M18 15.5V21.5"
				custom={0.3}
				variants={BAR_VARIANTS}
				animate={controls}
			/>
			<motion.path
				d="M21 18.5L15 18.5"
				custom={0.6}
				variants={BAR_VARIANTS}
				animate={controls}
			/>
		</>
	),
)
