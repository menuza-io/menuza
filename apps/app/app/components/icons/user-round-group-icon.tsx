'use client'

import { cn } from '@repo/ui'
import { type Variants, motion } from 'motion/react'
import { type HTMLAttributes, forwardRef } from 'react'
import {
	type IconAnimationHandle,
	useIconAnimation,
} from './use-icon-animation.tsx'

export interface UserRoundGroupIconHandle extends IconAnimationHandle {}

interface UserRoundGroupIconProps extends HTMLAttributes<HTMLDivElement> {
	size?: number
}

const spring = { type: 'spring', stiffness: 200, damping: 13 } as const

/** The centre person lifts slightly while the two side people slide in. */
const centerVariants: Variants = {
	normal: { y: 0, transition: spring },
	animate: { y: [2, 0], transition: spring },
}

const leftVariants: Variants = {
	normal: { x: 0, opacity: 1, transition: spring },
	animate: {
		x: [-3, 0],
		opacity: [0, 1],
		transition: { ...spring, delay: 0.1 },
	},
}

const rightVariants: Variants = {
	normal: { x: 0, opacity: 1, transition: spring },
	animate: {
		x: [3, 0],
		opacity: [0, 1],
		transition: { ...spring, delay: 0.1 },
	},
}

const UserRoundGroupIcon = forwardRef<
	UserRoundGroupIconHandle,
	UserRoundGroupIconProps
>(({ onMouseEnter, onMouseLeave, className, size = 28, ...props }, ref) => {
	const { controls, handleMouseEnter, handleMouseLeave } = useIconAnimation(
		ref,
		{ onMouseEnter, onMouseLeave },
	)

	return (
		<div
			className={cn(className)}
			onMouseEnter={handleMouseEnter}
			onMouseLeave={handleMouseLeave}
			{...props}
		>
			<svg
				fill="none"
				height={size}
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="2"
				viewBox="0 0 24 24"
				width={size}
				xmlns="http://www.w3.org/2000/svg"
			>
				<motion.g animate={controls} initial="normal" variants={centerVariants}>
					<path d="M17 21a5 5 0 00-10 0" />
					<circle cx="12" cy="13" r="3" />
				</motion.g>
				<motion.g animate={controls} initial="normal" variants={rightVariants}>
					<path d="M22 10.5a3.5 3.5 0 00-5.507-2.868" />
					<circle cx="18.5" cy="4.5" r="2.5" />
				</motion.g>
				<motion.g animate={controls} initial="normal" variants={leftVariants}>
					<path d="M7.507 7.632A3.5 3.5 0 002 10.5" />
					<circle cx="5.5" cy="4.5" r="2.5" />
				</motion.g>
			</svg>
		</div>
	)
})

UserRoundGroupIcon.displayName = 'UserRoundGroupIcon'

export { UserRoundGroupIcon }
