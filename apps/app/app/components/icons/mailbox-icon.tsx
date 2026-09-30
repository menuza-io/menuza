'use client'

import { cn } from '@repo/ui'
import {
	type Variants,
	motion,
	useAnimation,
	useReducedMotion,
} from 'motion/react'
import {
	type HTMLAttributes,
	forwardRef,
	useCallback,
	useImperativeHandle,
	useRef,
} from 'react'

export interface MailboxIconHandle {
	startAnimation: () => void
	stopAnimation: () => void
}

interface MailboxIconProps extends HTMLAttributes<HTMLDivElement> {
	size?: number
}

const FLAG_VARIANTS: Variants = {
	normal: {
		rotate: 0,
		transition: { type: 'spring', stiffness: 300, damping: 18 },
	},
	animate: {
		rotate: -90,
		transition: { type: 'spring', stiffness: 280, damping: 12, mass: 1 },
	},
}

export const MailboxIcon = forwardRef<MailboxIconHandle, MailboxIconProps>(
	({ onMouseEnter, onMouseLeave, className, size = 28, ...props }, ref) => {
		const controls = useAnimation()
		const reducedMotion = useReducedMotion()
		const controlled = useRef(false)
		const start = useCallback(() => {
			if (!reducedMotion) void controls.start('animate')
		}, [controls, reducedMotion])
		const stop = useCallback(() => {
			if (!reducedMotion) void controls.start('normal')
		}, [controls, reducedMotion])
		useImperativeHandle(ref, () => {
			controlled.current = true
			return { startAnimation: start, stopAnimation: stop }
		}, [start, stop])
		return (
			<div
				className={cn(className)}
				onMouseEnter={(event) => {
					if (!controlled.current) start()
					onMouseEnter?.(event)
				}}
				onMouseLeave={(event) => {
					if (!controlled.current) stop()
					onMouseLeave?.(event)
				}}
				{...props}
			>
				<svg
					aria-hidden="true"
					className="overflow-visible"
					fill="none"
					height={size}
					width={size}
					stroke="currentColor"
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth="2"
					viewBox="0 0 24 24"
					xmlns="http://www.w3.org/2000/svg"
				>
					<path d="M22 17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9.5C2 7 4 5 6.5 5H18c2.2 0 4 1.8 4 4v8Z" />
					<motion.path
						animate={reducedMotion ? 'normal' : controls}
						d="M18 11V9H15"
						initial="normal"
						style={{ transformOrigin: '18px 11px' }}
						variants={FLAG_VARIANTS}
					/>
					<path d="M6.5 5C9 5 11 7 11 9.5V17a2 2 0 0 1-2 2" />
					<line x1="6" x2="7" y1="10" y2="10" />
				</svg>
			</div>
		)
	},
)
MailboxIcon.displayName = 'MailboxIcon'
