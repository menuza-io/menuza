'use client'

import { type Variants, motion } from 'motion/react'
import { type AnimatedIconHandle, createAnimatedIcon } from './animated-icon'

export type ArrowLeftIconHandle = AnimatedIconHandle

const SHAFT_VARIANTS: Variants = {
	normal: { d: 'M5.5 12.002H19' },
	animate: {
		d: ['M5.5 12.002H19', 'M10.5 12.002H19', 'M5.5 12.002H19'],
		transition: { duration: 0.4 },
	},
}

const HEAD_VARIANTS: Variants = {
	normal: { x: 0 },
	animate: { x: [0, 3, 0], transition: { duration: 0.4 } },
}

/** Hugeicons `arrow-left-02`: the head pulls back along the shaft. */
export const ArrowLeftIcon = createAnimatedIcon('ArrowLeftIcon', (controls) => (
	<>
		<motion.path
			d="M5.5 12.002H19"
			variants={SHAFT_VARIANTS}
			animate={controls}
		/>
		<motion.path
			d="M10.9999 18.002C10.9999 18.002 4.99998 13.583 4.99997 12.0019C4.99996 10.4208 11 6.00195 11 6.00195"
			variants={HEAD_VARIANTS}
			animate={controls}
		/>
	</>
))
