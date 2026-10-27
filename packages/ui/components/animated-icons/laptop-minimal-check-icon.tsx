'use client'

import { type Variants, motion } from 'motion/react'
import { type AnimatedIconHandle, createAnimatedIcon } from './animated-icon'

export type LaptopMinimalCheckIconHandle = AnimatedIconHandle

const CHECK_VARIANTS: Variants = {
	normal: { pathLength: 1, opacity: 1, transition: { duration: 0.3 } },
	animate: {
		pathLength: [0, 1],
		opacity: [0, 1],
		transition: { duration: 0.4, ease: 'easeInOut' },
	},
}

/** Hugeicons `laptop-check`: the check mark is drawn on the screen. */
export const LaptopMinimalCheckIcon = createAnimatedIcon(
	'LaptopMinimalCheckIcon',
	(controls) => (
		<>
			<path d="M20.4999 16.5V8.5C20.4999 6.14298 20.4999 4.96447 19.7676 4.23223C19.0354 3.5 17.8569 3.5 15.4999 3.5H8.49988C6.14286 3.5 4.96434 3.5 4.23211 4.23223C3.49988 4.96447 3.49988 6.14298 3.49988 8.5V16.5" />
			<path d="M21.9841 20.5H2.01567C1.63273 20.5 1.38367 20.1088 1.55493 19.7764L3.49988 16.5H20.4999L22.4448 19.7764C22.6161 20.1088 22.367 20.5 21.9841 20.5Z" />
			<motion.path
				d="M9.49988 10.4C9.49988 10.4 10.357 10.8 10.9999 12C10.9999 12 13.3822 8.66667 15.4999 8"
				initial="normal"
				variants={CHECK_VARIANTS}
				animate={controls}
			/>
		</>
	),
)
