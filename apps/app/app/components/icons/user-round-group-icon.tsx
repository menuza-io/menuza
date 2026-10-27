import { type Variants, motion } from 'motion/react'
import {
	type AnimatedIconHandle,
	createAnimatedIcon,
} from '@repo/ui/animated-icon'

export type UserRoundGroupIconHandle = AnimatedIconHandle

const spring = { type: 'spring', stiffness: 200, damping: 13 } as const

/** The centre person lifts slightly while the two side people slide in. */
const centerVariants: Variants = {
	normal: { y: 0, transition: spring },
	animate: { y: [2, 0], transition: spring },
}

const sideVariants: Variants = {
	normal: { x: 0, opacity: 1, transition: spring },
	animate: (direction: number) => ({
		x: [3 * direction, 0],
		opacity: [0, 1],
		transition: { ...spring, delay: 0.1 },
	}),
}

/** Hugeicons `user-group`. */
export const UserRoundGroupIcon = createAnimatedIcon(
	'UserRoundGroupIcon',
	(controls) => (
		<>
			<motion.g initial="normal" variants={centerVariants} animate={controls}>
				<path d="M18.4995 20.5C18.2663 17.5685 15.8417 15.2477 12.808 15.0521L11.9995 15C11.7107 15.0076 11.4416 15.0178 11.1877 15.0298C8.18075 15.1723 5.7304 17.5974 5.49951 20.5" />
				<path d="M15.2495 9.25C15.2495 11.0449 13.7944 12.5 11.9995 12.5C10.2046 12.5 8.74952 11.0449 8.74952 9.25C8.74952 7.45507 10.2046 6 11.9995 6C13.7944 6 15.2495 7.45507 15.2495 9.25Z" />
			</motion.g>
			<motion.g
				custom={1}
				initial="normal"
				variants={sideVariants}
				animate={controls}
			>
				<path d="M18.4963 8.5C18.8197 7.99485 19.0072 7.39432 19.0072 6.75C19.0072 4.95507 17.5521 3.5 15.7572 3.5C15.3113 3.5 14.8863 3.58982 14.4994 3.75235" />
				<path d="M22.0007 17.9996C21.8208 15.7374 19.9995 13.5 17.9995 13" />
			</motion.g>
			<motion.g
				custom={-1}
				initial="normal"
				variants={sideVariants}
				animate={controls}
			>
				<path d="M5.50249 8.5C5.17908 7.99485 4.99158 7.39432 4.99158 6.75C4.99158 4.95507 6.44665 3.5 8.24157 3.5C8.68752 3.5 9.1125 3.58982 9.49939 3.75235" />
				<path d="M1.99927 17.9996C2.17923 15.7374 4.00049 13.5 6.00049 13" />
			</motion.g>
		</>
	),
)
