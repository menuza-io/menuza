'use client'

import { type Variants, motion } from 'motion/react'
import { type AnimatedIconHandle, createAnimatedIcon } from './animated-icon'

export type SunMoonIconHandle = AnimatedIconHandle

const MOON_VARIANTS: Variants = {
	normal: { rotate: 0 },
	animate: {
		rotate: [0, -5, 5, -2, 2, 0],
		transition: { duration: 1.5, ease: 'easeInOut' },
	},
}

const RAY_VARIANTS: Variants = {
	normal: { opacity: 1 },
	animate: (index: number) => ({
		opacity: [0, 1],
		transition: { delay: index * 0.1, duration: 0.3 },
	}),
}

const RAYS = [
	'M16.5 11.5C16.5 9.567 14.933 8 13 8',
	'M13.5 2.5V4.5',
	'M19.5018 4.5L18.0028 5.99902',
	'M21.5018 10.5H19.502',
]

/** Hugeicons `sun-moon`: the moon rocks while the sun's rays fade back in. */
export const SunMoonIcon = createAnimatedIcon('SunMoonIcon', (controls) => (
	<>
		<motion.path
			d="M17 16.5314C16.116 17.0034 15.1064 17.271 14.0343 17.271C10.552 17.271 7.72899 14.448 7.72899 10.9657C7.72899 9.89358 7.99657 8.88398 8.46857 8C5.33406 8.73462 3 11.548 3 14.9065C3 18.8241 6.17586 22 10.0935 22C13.452 22 16.2654 19.6659 17 16.5314Z"
			variants={MOON_VARIANTS}
			animate={controls}
		/>
		{RAYS.map((d, index) => (
			<motion.path
				key={d}
				d={d}
				custom={index + 1}
				variants={RAY_VARIANTS}
				animate={controls}
			/>
		))}
	</>
))
