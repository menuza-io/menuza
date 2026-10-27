'use client'

import { type Variants, motion } from 'motion/react'
import { type AnimatedIconHandle, createAnimatedIcon } from './animated-icon'

export type FlaskIconHandle = AnimatedIconHandle

const FLASK_VARIANTS: Variants = {
	normal: { rotate: 0, originY: '100%' },
	animate: {
		rotate: [0, 6, -6, 3, -3, 0],
		originY: '100%',
		transition: { duration: 0.8 },
	},
}

const LIQUID_VARIANTS: Variants = {
	normal: { pathLength: 1, opacity: 1 },
	animate: {
		pathLength: [0, 1],
		opacity: [0, 1],
		transition: { duration: 0.6, delay: 0.2 },
	},
}

/** Hugeicons `flask-conical`: the flask sways on its base and refills. */
export const FlaskIcon = createAnimatedIcon('FlaskIcon', (controls) => (
	<motion.g variants={FLASK_VARIANTS} animate={controls}>
		<path d="M14.4973 2V8.25401C14.4973 8.72617 14.7093 9.1734 15.0747 9.47239L15.7421 10.0184C18.4717 12.2518 20.2277 15.4577 20.6397 18.9604C20.8301 20.5784 19.5659 22 17.9368 22H6.05789C4.42876 22 3.16459 20.5784 3.35494 18.9604C3.76702 15.4577 5.52295 12.2518 8.25261 10.0184L8.91998 9.47239C9.28541 9.1734 9.49734 8.72617 9.49734 8.25401V2" />
		<path d="M7.99707 2H15.9971" />
		<motion.path
			d="M5.49707 14.0183C5.74095 14.0063 5.99072 14 6.24707 14C9.99707 14 13.7471 17 17.4971 17C18.2729 17 18.9332 16.9384 19.4971 16.8334"
			variants={LIQUID_VARIANTS}
			animate={controls}
		/>
	</motion.g>
))
