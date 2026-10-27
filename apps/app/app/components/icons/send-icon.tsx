import { type Variants, motion } from 'motion/react'
import {
	type AnimatedIconHandle,
	createAnimatedIcon,
} from '@repo/ui/animated-icon'

export type SendIconHandle = AnimatedIconHandle

const PLANE_VARIANTS: Variants = {
	normal: { x: 0, y: 0, scale: 1 },
	animate: { x: 3, y: -3, scale: 0.8 },
}

const TRAIL_VARIANTS: Variants = {
	normal: {
		pathLength: 0,
		opacity: 0,
		x: -3,
		y: 3,
		transition: { duration: 0.3 },
	},
	animate: { pathLength: 1, opacity: 1, x: 0, y: 0 },
}

/** Hugeicons `sent`: the plane flies off and leaves a looping trail. */
export const SendIcon = createAnimatedIcon('SendIcon', (controls) => (
	<>
		<motion.g
			transition={{ duration: 0.5 }}
			variants={PLANE_VARIANTS}
			animate={controls}
		>
			<path d="M21.0477 3.05293C18.8697 0.707363 2.48648 6.4532 2.50001 8.551C2.51535 10.9299 8.89809 11.6617 10.6672 12.1581C11.7311 12.4565 12.016 12.7625 12.2613 13.8781C13.3723 18.9305 13.9301 21.4435 15.2014 21.4996C17.2278 21.5892 23.1733 5.342 21.0477 3.05293Z" />
			<path d="M11.4999 12.5L14.9999 9" />
		</motion.g>
		<motion.path
			d="M -3 28 C -0.5 26.8 1.6 24.6 3.3 22 C 4.8 19.7 5.2 17.6 4.2 16.1 C 3.2 14.7 1.4 14.5 0.3 15.8 C -0.9 17.2 -0.6 19.4 1.2 20.4 C 3.4 21.5 6.4 19.4 9 15.8"
			strokeDasharray="2 2"
			strokeWidth="1"
			initial="normal"
			transition={{ duration: 0.55, delay: 0.1 }}
			variants={TRAIL_VARIANTS}
			animate={controls}
		/>
	</>
))
