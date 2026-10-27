'use client'

import { type Variants, motion } from 'motion/react'
import { type AnimatedIconHandle, createAnimatedIcon } from './animated-icon'

export type GlobeIconHandle = AnimatedIconHandle

const MERIDIAN_VARIANTS: Variants = {
	normal: { scaleX: 1 },
	animate: {
		scaleX: [1, 0.15, 1],
		transition: { duration: 0.6, ease: 'easeInOut' },
	},
}

/** Hugeicons `globe-02`: the meridian narrows and widens, as if it spins. */
export const GlobeIcon = createAnimatedIcon('GlobeIcon', (controls) => (
	<>
		<circle cx="12" cy="12" r="10" />
		<motion.path
			d="M8 12C8 18 12 22 12 22C12 22 16 18 16 12C16 6 12 2 12 2C12 2 8 6 8 12Z"
			variants={MERIDIAN_VARIANTS}
			animate={controls}
		/>
		<path d="M21 15H3" />
		<path d="M21 9H3" />
	</>
))
