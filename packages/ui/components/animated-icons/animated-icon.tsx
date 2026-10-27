'use client'

import { useAnimation, useReducedMotion } from 'motion/react'
import {
	type HTMLAttributes,
	type ReactNode,
	forwardRef,
	useCallback,
	useImperativeHandle,
	useRef,
} from 'react'
import { cn } from '../../lib/utils'

export interface AnimatedIconHandle {
	startAnimation: () => void
	stopAnimation: () => void
}

export interface AnimatedIconProps extends HTMLAttributes<HTMLDivElement> {
	size?: number
}

export type AnimatedIconControls = ReturnType<typeof useAnimation>

/**
 * Builds a hover-animated Hugeicons icon (stroke rounded, 24px grid, 1.5px
 * stroke). Copy the icon's paths from
 * https://github.com/hugeicons/hugeicons/tree/main/icons, dropping the
 * hard-coded stroke attributes, which the wrapping `<svg>` sets.
 *
 * `renderIcon` returns the `<svg>` children. Parts that move get
 * `animate={controls}` and variants named `normal` (at rest) and `animate`.
 *
 * The icon animates on hover unless a parent takes over through the ref
 * (`startAnimation` / `stopAnimation`), as the sidebars do for the whole row.
 * Nothing moves when the user prefers reduced motion.
 */
export function createAnimatedIcon(
	displayName: string,
	renderIcon: (controls: AnimatedIconControls) => ReactNode,
) {
	const AnimatedIcon = forwardRef<AnimatedIconHandle, AnimatedIconProps>(
		({ onMouseEnter, onMouseLeave, className, size = 28, ...props }, ref) => {
			const controls = useAnimation()
			const reduceMotion = useReducedMotion()
			const isControlledRef = useRef(false)

			const startAnimation = useCallback(() => {
				if (!reduceMotion) void controls.start('animate')
			}, [controls, reduceMotion])

			const stopAnimation = useCallback(() => {
				void controls.start('normal')
			}, [controls])

			useImperativeHandle(
				ref,
				() => {
					isControlledRef.current = true
					return { startAnimation, stopAnimation }
				},
				[startAnimation, stopAnimation],
			)

			const handleMouseEnter = useCallback(
				(e: React.MouseEvent<HTMLDivElement>) => {
					if (!isControlledRef.current) startAnimation()
					onMouseEnter?.(e)
				},
				[startAnimation, onMouseEnter],
			)

			const handleMouseLeave = useCallback(
				(e: React.MouseEvent<HTMLDivElement>) => {
					if (!isControlledRef.current) stopAnimation()
					onMouseLeave?.(e)
				},
				[stopAnimation, onMouseLeave],
			)

			return (
				<div
					className={cn(className)}
					onMouseEnter={handleMouseEnter}
					onMouseLeave={handleMouseLeave}
					{...props}
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width={size}
						height={size}
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
						className="overflow-visible"
					>
						{renderIcon(controls)}
					</svg>
				</div>
			)
		},
	)

	AnimatedIcon.displayName = displayName

	return AnimatedIcon
}
