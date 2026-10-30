import {
	type AnimatedIconHandle,
	createAnimatedIcon,
} from '@repo/ui/animated-icon'
import { type Variants, motion } from 'motion/react'

export type NoteIconHandle = AnimatedIconHandle

const RING_VARIANTS: Variants = {
	normal: { y: 0 },
	animate: (index: number) => ({
		y: [0, -1.5, 0],
		transition: { duration: 0.3, delay: index * 0.08 },
	}),
}

const LINE_VARIANTS: Variants = {
	normal: { pathLength: 1 },
	animate: (delay: number) => ({
		pathLength: [1, 0, 1],
		transition: { duration: 0.6, delay },
	}),
}

const RINGS = ['M7.5 2V5', 'M12 2V5', 'M16.5 2V5']

/** Hugeicons `note-01`: the rings hop one by one, then the lines are rewritten. */
export const NoteIcon = createAnimatedIcon('NoteIcon', (controls) => (
	<>
		{RINGS.map((d, index) => (
			<motion.path
				key={d}
				d={d}
				custom={index}
				variants={RING_VARIANTS}
				animate={controls}
			/>
		))}
		<path d="M13 3.5H11C7.70017 3.5 6.05025 3.5 5.02513 4.52513C4 5.55025 4 7.20017 4 10.5V15C4 18.2998 4 19.9497 5.02513 20.9749C6.05025 22 7.70017 22 11 22H13C16.2998 22 17.9497 22 18.9749 20.9749C20 19.9497 20 18.2998 20 15V10.5C20 7.20017 20 5.55025 18.9749 4.52512C17.9497 3.5 16.2998 3.5 13 3.5Z" />
		<motion.path
			d="M8 11H16"
			custom={0.25}
			variants={LINE_VARIANTS}
			animate={controls}
		/>
		<motion.path
			d="M8 15H12"
			custom={0.4}
			variants={LINE_VARIANTS}
			animate={controls}
		/>
	</>
))
