import { type Variants, motion } from 'motion/react'
import {
	type AnimatedIconHandle,
	createAnimatedIcon,
} from '@repo/ui/animated-icon'

export type UtensilsIconHandle = AnimatedIconHandle

const FORK_VARIANTS: Variants = {
	normal: {
		rotate: 0,
		transition: { type: 'spring', stiffness: 260, damping: 20 },
	},
	animate: {
		rotate: [0, -8, 6, 0],
		transition: { duration: 0.42, ease: [0.16, 1, 0.3, 1] },
	},
}

/** Hugeicons `utensils`: the fork wiggles. */
export const UtensilsIcon = createAnimatedIcon('UtensilsIcon', (controls) => (
	<>
		<motion.g
			variants={FORK_VARIANTS}
			animate={controls}
			initial="normal"
			style={{ originX: '7px', originY: '21px' }}
		>
			<path d="M7 11.5V21M4 3V8C4 8.93188 4 9.39782 4.15224 9.76537C4.35523 10.2554 4.74458 10.6448 5.23463 10.8478C5.60218 11 6.06812 11 7 11C7.93188 11 8.39782 11 8.76537 10.8478C9.25542 10.6448 9.64477 10.2554 9.84776 9.76537C10 9.39782 10 8.93188 10 8V3" />
			<path d="M7 8V3" />
		</motion.g>
		<path d="M16 21V14M16 14V3C18.2091 3 20 4.79086 20 7V10.3333C20 11.8971 20 12.6789 19.5867 13.2175C19.4803 13.3562 19.3562 13.4803 19.2175 13.5867C18.6789 14 17.8971 14 16.3333 14H16Z" />
	</>
))
