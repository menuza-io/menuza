'use client'

import { type Variants, motion } from 'motion/react'
import { type AnimatedIconHandle, createAnimatedIcon } from './animated-icon'

export type UserIconHandle = AnimatedIconHandle

const HEAD_VARIANTS: Variants = {
	normal: { pathLength: 1, pathOffset: 0, scale: 1 },
	animate: { pathLength: [0, 1], pathOffset: [1, 0], scale: [0.5, 1] },
}

const BODY_VARIANTS: Variants = {
	normal: { pathLength: 1, opacity: 1, pathOffset: 0 },
	animate: {
		pathLength: [0, 1],
		opacity: [0, 1],
		pathOffset: [1, 0],
		transition: { delay: 0.2, duration: 0.4 },
	},
}

/** Hugeicons `user`: head, then shoulders, are drawn in. */
export const UserIcon = createAnimatedIcon('UserIcon', (controls) => (
	<>
		<motion.path
			d="M20 21.0001C19.713 17.269 16.7289 14.3151 12.995 14.0662L12 13.9999C11.6446 14.0096 11.3134 14.0225 11.0008 14.0378C7.3 14.2192 4.28417 17.3057 4 21.0001"
			variants={BODY_VARIANTS}
			animate={controls}
		/>
		<motion.circle
			cx="12"
			cy="6.99988"
			r="4"
			variants={HEAD_VARIANTS}
			animate={controls}
		/>
	</>
))
