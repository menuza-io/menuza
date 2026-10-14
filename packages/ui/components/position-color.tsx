import { type ReactNode } from 'react'
import { cn } from '../lib/utils'

/**
 * Staff positions carry a color *key* (never a hex value), so the shade follows
 * the light and dark themes. Each key maps to a `--position-*` token defined in
 * `styles/tailwind.css`. Class names are listed in full so Tailwind can see them.
 */
const POSITION_COLORS = {
	neutral: {
		dot: 'bg-position-neutral',
		chip: 'bg-position-neutral/15',
		live: 'bg-position-neutral/15 border-position-neutral/40',
		draft: 'bg-background border-position-neutral/80',
	},
	red: {
		dot: 'bg-position-red',
		chip: 'bg-position-red/15',
		live: 'bg-position-red/15 border-position-red/40',
		draft: 'bg-background border-position-red/80',
	},
	orange: {
		dot: 'bg-position-orange',
		chip: 'bg-position-orange/15',
		live: 'bg-position-orange/15 border-position-orange/40',
		draft: 'bg-background border-position-orange/80',
	},
	amber: {
		dot: 'bg-position-amber',
		chip: 'bg-position-amber/15',
		live: 'bg-position-amber/15 border-position-amber/40',
		draft: 'bg-background border-position-amber/80',
	},
	green: {
		dot: 'bg-position-green',
		chip: 'bg-position-green/15',
		live: 'bg-position-green/15 border-position-green/40',
		draft: 'bg-background border-position-green/80',
	},
	teal: {
		dot: 'bg-position-teal',
		chip: 'bg-position-teal/15',
		live: 'bg-position-teal/15 border-position-teal/40',
		draft: 'bg-background border-position-teal/80',
	},
	blue: {
		dot: 'bg-position-blue',
		chip: 'bg-position-blue/15',
		live: 'bg-position-blue/15 border-position-blue/40',
		draft: 'bg-background border-position-blue/80',
	},
	violet: {
		dot: 'bg-position-violet',
		chip: 'bg-position-violet/15',
		live: 'bg-position-violet/15 border-position-violet/40',
		draft: 'bg-background border-position-violet/80',
	},
	pink: {
		dot: 'bg-position-pink',
		chip: 'bg-position-pink/15',
		live: 'bg-position-pink/15 border-position-pink/40',
		draft: 'bg-background border-position-pink/80',
	},
} as const

export type PositionColorKey = keyof typeof POSITION_COLORS

export const POSITION_COLOR_KEYS = Object.keys(
	POSITION_COLORS,
) as PositionColorKey[]

function resolve(colorKey: string | null | undefined) {
	return Object.hasOwn(POSITION_COLORS, colorKey ?? '')
		? POSITION_COLORS[colorKey as PositionColorKey]
		: POSITION_COLORS.neutral
}

/** A small round swatch. Decorative: pair it with the position name. */
export function PositionDot({
	colorKey,
	className,
}: {
	colorKey: string | null | undefined
	className?: string
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				'inline-block size-2.5 shrink-0 rounded-full',
				resolve(colorKey).dot,
				className,
			)}
		/>
	)
}

/** A position name on a tinted pill. */
export function PositionChip({
	colorKey,
	className,
	children,
}: {
	colorKey: string | null | undefined
	className?: string
	children: ReactNode
}) {
	return (
		<span
			className={cn(
				'text-foreground inline-flex h-5 max-w-full items-center gap-1.5 rounded-4xl px-2 text-xs font-medium whitespace-nowrap',
				resolve(colorKey).chip,
				className,
			)}
		>
			<PositionDot colorKey={colorKey} className="size-2" />
			<span className="truncate">{children}</span>
		</span>
	)
}

/**
 * Background and border classes for a shift block in a schedule grid. A live
 * (published) shift is a soft tint of its position; a draft is an outlined,
 * dashed block, so what is not yet published reads at a glance in light and
 * dark themes without leaning on a different hue.
 */
export function positionBlockClass(
	colorKey: string | null | undefined,
	draft: boolean,
): string {
	const colors = resolve(colorKey)
	return draft ? cn('border-dashed', colors.draft) : colors.live
}
