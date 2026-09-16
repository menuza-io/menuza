'use client'

import { cn } from '@repo/ui'
import { type Variants, motion } from 'motion/react'
import { type HTMLAttributes, forwardRef } from 'react'
import {
	type IconAnimationHandle,
	useIconAnimation,
} from './use-icon-animation.tsx'

export interface GalleryHorizontalEndIconHandle extends IconAnimationHandle {}

interface GalleryHorizontalEndIconProps extends HTMLAttributes<HTMLDivElement> {
	size?: number
}

const PATH_VARIANTS: Variants = {
	normal: {
		translateX: 0,
		opacity: 1,
		transition: {
			type: 'tween',
			stiffness: 200,
			damping: 13,
		},
	},
	animate: (i: number) => ({
		translateX: [2 * i, 0],
		opacity: [0, 1],
		transition: {
			delay: 0.25 * (2 - i),
			type: 'tween',
			stiffness: 200,
			damping: 13,
		},
	}),
}

const GalleryHorizontalEndIcon = forwardRef<
	GalleryHorizontalEndIconHandle,
	GalleryHorizontalEndIconProps
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
				<motion.path
					animate={controls}
					custom={2}
					d="M6 5v14"
					variants={PATH_VARIANTS}
				/>
				<motion.path
					animate={controls}
					custom={1}
					d="M2 7v10"
					variants={PATH_VARIANTS}
				/>
				<rect height="18" rx="2" width="12" x="10" y="3" />
			</svg>
		</div>
	)
})

GalleryHorizontalEndIcon.displayName = 'GalleryHorizontalEndIcon'

export { GalleryHorizontalEndIcon }
