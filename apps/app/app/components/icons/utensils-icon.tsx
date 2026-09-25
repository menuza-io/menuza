'use client'

import { cn } from '@repo/ui'
import { type Variants, motion } from 'motion/react'
import { type HTMLAttributes, forwardRef } from 'react'
import {
	type IconAnimationHandle,
	useIconAnimation,
} from './use-icon-animation.tsx'

export interface UtensilsIconHandle extends IconAnimationHandle {}

interface UtensilsIconProps extends HTMLAttributes<HTMLDivElement> {
	size?: number
}

const FORK_VARIANTS: Variants = {
	normal: {
		rotate: 0,
		transition: {
			type: 'spring',
			stiffness: 260,
			damping: 20,
		},
	},
	animate: {
		rotate: [0, -8, 6, 0],
		transition: {
			duration: 0.42,
			ease: [0.16, 1, 0.3, 1],
		},
	},
}

const UtensilsIcon = forwardRef<UtensilsIconHandle, UtensilsIconProps>(
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
						className="origin-center"
						variants={FORK_VARIANTS}
					>
						<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2" />
						<path d="M7 2v20" />
					</motion.g>
					<path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7" />
				</svg>
			</div>
		)
	},
)

UtensilsIcon.displayName = 'UtensilsIcon'

export { UtensilsIcon }
