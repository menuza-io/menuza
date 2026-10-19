'use client'

import { cn } from '@repo/ui'
import { type Variants, motion } from 'motion/react'
import { type HTMLAttributes, forwardRef } from 'react'
import {
	type IconAnimationHandle,
	useIconAnimation,
} from './use-icon-animation.tsx'

export interface ReceiptIconHandle extends IconAnimationHandle {}

interface ReceiptIconProps extends HTMLAttributes<HTMLDivElement> {
	size?: number
}

const SLIP_VARIANTS: Variants = {
	normal: {
		y: 0,
		transition: { type: 'spring', stiffness: 260, damping: 20 },
	},
	animate: {
		y: [0, -1.5, 0],
		transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] },
	},
}

const MARK_VARIANTS: Variants = {
	normal: {
		pathLength: 1,
		opacity: 1,
		transition: { duration: 0.2 },
	},
	animate: {
		pathLength: [0, 1],
		opacity: [0, 1],
		transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] },
	},
}

const ReceiptIcon = forwardRef<ReceiptIconHandle, ReceiptIconProps>(
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
					<motion.path
						animate={controls}
						d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"
						variants={SLIP_VARIANTS}
					/>
					<motion.path
						animate={controls}
						d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"
						initial="normal"
						variants={MARK_VARIANTS}
					/>
					<motion.path
						animate={controls}
						d="M12 17.5v-11"
						initial="normal"
						variants={MARK_VARIANTS}
					/>
				</svg>
			</div>
		)
	},
)

ReceiptIcon.displayName = 'ReceiptIcon'

export { ReceiptIcon }
