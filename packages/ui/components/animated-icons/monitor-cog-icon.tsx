'use client'

import { motion, useAnimation, useReducedMotion } from 'motion/react'
import {
	type HTMLAttributes,
	forwardRef,
	useCallback,
	useImperativeHandle,
	useRef,
} from 'react'
import { cn } from '@repo/ui'

export interface MonitorCogIconHandle {
	startAnimation: () => void
	stopAnimation: () => void
}

interface MonitorCogIconProps extends HTMLAttributes<HTMLDivElement> {
	size?: number
}

const MonitorCogIcon = forwardRef<MonitorCogIconHandle, MonitorCogIconProps>(
	({ onMouseEnter, onMouseLeave, className, size = 28, ...props }, ref) => {
		const controls = useAnimation()
		const prefersReducedMotion = useReducedMotion()
		const isControlledRef = useRef(false)

		const startAnimation = useCallback(() => {
			void controls.start(prefersReducedMotion ? 'normal' : 'animate')
		}, [controls, prefersReducedMotion])

		const stopAnimation = useCallback(() => {
			void controls.start('normal')
		}, [controls])

		useImperativeHandle(ref, () => {
			isControlledRef.current = true

			return { startAnimation, stopAnimation }
		}, [startAnimation, stopAnimation])

		const handleMouseEnter = useCallback(
			(e: React.MouseEvent<HTMLDivElement>) => {
				if (isControlledRef.current) {
					onMouseEnter?.(e)
				} else {
					startAnimation()
				}
			},
			[onMouseEnter, startAnimation],
		)

		const handleMouseLeave = useCallback(
			(e: React.MouseEvent<HTMLDivElement>) => {
				if (isControlledRef.current) {
					onMouseLeave?.(e)
				} else {
					stopAnimation()
				}
			},
			[onMouseLeave, stopAnimation],
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
					<path d="M12 17v4" />
					<path d="M22 13v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7" />
					<path d="M8 21h8" />
					<motion.g
						animate={controls}
						initial="normal"
						transition={{ type: 'spring', stiffness: 50, damping: 10 }}
						variants={{ normal: { rotate: 0 }, animate: { rotate: 180 } }}
					>
						<path d="m14.305 7.53.923-.382" />
						<path d="m15.228 4.852-.923-.383" />
						<path d="m16.852 3.228-.383-.924" />
						<path d="m16.852 8.772-.383.923" />
						<path d="m19.148 3.228.383-.924" />
						<path d="m19.53 9.696-.382-.924" />
						<path d="m20.772 4.852.924-.383" />
						<path d="m20.772 7.148.924.383" />
						<circle cx="18" cy="6" r="3" />
					</motion.g>
				</svg>
			</div>
		)
	},
)

MonitorCogIcon.displayName = 'MonitorCogIcon'

export { MonitorCogIcon }
