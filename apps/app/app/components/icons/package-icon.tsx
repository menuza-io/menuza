import {
	type AnimatedIconHandle,
	createAnimatedIcon,
} from '@repo/ui/animated-icon'
import { type Variants, motion } from 'motion/react'

export type PackageIconHandle = AnimatedIconHandle

const LID_VARIANTS: Variants = {
	normal: {
		y: 0,
		transition: { type: 'spring', stiffness: 260, damping: 20 },
	},
	animate: {
		y: [0, -1.5, 0],
		transition: { duration: 0.45, ease: [0.16, 1, 0.3, 1] },
	},
}

const STRAP_VARIANTS: Variants = {
	normal: { pathLength: 1, opacity: 1, transition: { duration: 0.2 } },
	animate: {
		pathLength: [0, 1],
		opacity: [0, 1],
		transition: { delay: 0.1, duration: 0.45, ease: [0.16, 1, 0.3, 1] },
	},
}

/** Hugeicons `package`: the lid lifts and settles while the strap is redrawn. */
export const PackageIcon = createAnimatedIcon('PackageIcon', (controls) => (
	<>
		<path d="M12 22C11.1818 22 10.4002 21.6698 8.83693 21.0095C4.94564 19.3657 3 18.5438 3 17.1613V7M12 22C12.8182 22 13.5998 21.6698 15.1631 21.0095C19.0544 19.3657 21 18.5438 21 17.1613V7M12 22V11.3548" />
		<motion.path
			d="M8.32592 9.69138L5.40472 8.27785C3.80157 7.5021 3 7.11423 3 6.5C3 5.88577 3.80157 5.4979 5.40472 4.72215L8.32592 3.30862C10.1288 2.43621 11.0303 2 12 2C12.9697 2 13.8712 2.4362 15.6741 3.30862L18.5953 4.72215C20.1984 5.4979 21 5.88577 21 6.5C21 7.11423 20.1984 7.5021 18.5953 8.27785L15.6741 9.69138C13.8712 10.5638 12.9697 11 12 11C11.0303 11 10.1288 10.5638 8.32592 9.69138Z"
			variants={LID_VARIANTS}
			animate={controls}
			initial="normal"
		/>
		<path d="M6 12L8 13" />
		<motion.path
			d="M17 4L7 9"
			variants={STRAP_VARIANTS}
			animate={controls}
			initial="normal"
		/>
	</>
))
