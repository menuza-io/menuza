'use client'

import { cn } from '@repo/ui'
import { type Variants, motion } from 'motion/react'
import { type HTMLAttributes, forwardRef } from 'react'
import {
	type IconAnimationHandle,
	useIconAnimation,
} from './use-icon-animation.tsx'

export interface CalendarIconHandle extends IconAnimationHandle {}

interface CalendarIconProps extends HTMLAttributes<HTMLDivElement> {
	size?: number
}

const spring = { type: 'spring', stiffness: 200, damping: 13 } as const

const frameVariants: Variants = {
	normal: { y: 0, transition: spring },
	animate: { y: [-1, 0], transition: spring },
}

const CalendarIcon = forwardRef<CalendarIconHandle, CalendarIconProps>(
	({ onMouseEnter, onMouseLeave, className, size = 28, ...props }, ref) => {
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
					<motion.g
						animate={controls}
						initial="normal"
						variants={frameVariants}
					>
						<path d="M8 2v4" />
						<path d="M16 2v4" />
						<rect width="18" height="18" x="3" y="4" rx="2" />
						<path d="M3 10h18" />
					</motion.g>
				</svg>
			</div>
		)
	},
)

CalendarIcon.displayName = 'CalendarIcon'

export { CalendarIcon }
