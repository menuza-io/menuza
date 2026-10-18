import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react'
import { RESERVATION_STATUSES } from '@repo/reservations'
import { cn } from '@repo/ui'

/**
 * The one status vocabulary for the host stand (`ui-design-conventions.md` C6).
 * Reservation statuses, live table states and waitlist states map onto the
 * existing semantic tokens only (`primary`, `success`, `warning`,
 * `destructive`, `muted`), so Today rows, Timeline bars, Floor tiles, Calendar
 * and the sheets read the same. Never rely on color alone: `StatusLabel` always
 * prints the word next to the dot.
 *
 * Attention is the only loud thing: normal states stay neutral or quiet.
 */

export type StatusTone =
	'neutral' | 'primary' | 'success' | 'warning' | 'destructive' | 'muted'

export type StatusBadgeVariant =
	'secondary' | 'default' | 'success' | 'warning' | 'destructive' | 'outline'

export type StatusStyle = {
	tone: StatusTone
	/** `Badge` variant for places that still need a chip. */
	badge: StatusBadgeVariant
	/** Translated label descriptor (render with `i18n._`). */
	label: MessageDescriptor
	/** Dot color (`bg-*`). */
	dot: string
	/** Text color for the label next to the dot. */
	text: string
	/** Bar / tile surface: background + border (+ dashed or ring when needed). */
	surface: string
	/** Text color that stays legible on `surface`. */
	surfaceText: string
	/** Cancelled-like states strike the name through. */
	strike: boolean
}

type ToneParts = Omit<StatusStyle, 'label' | 'strike' | 'badge'>

const TONES: Record<StatusTone, ToneParts> = {
	neutral: {
		tone: 'neutral',
		dot: 'bg-muted-foreground/50',
		text: 'text-muted-foreground',
		surface: 'bg-card border-border-strong',
		surfaceText: 'text-foreground',
	},
	primary: {
		tone: 'primary',
		dot: 'bg-primary',
		text: 'text-foreground',
		surface: 'bg-primary/10 border-primary/40',
		surfaceText: 'text-foreground',
	},
	success: {
		tone: 'success',
		dot: 'bg-success',
		text: 'text-foreground',
		surface: 'bg-success/10 border-success/40',
		surfaceText: 'text-foreground',
	},
	warning: {
		tone: 'warning',
		dot: 'bg-warning',
		text: 'text-warning',
		surface: 'bg-warning/12 border-warning/40',
		surfaceText: 'text-foreground',
	},
	destructive: {
		tone: 'destructive',
		dot: 'bg-destructive',
		text: 'text-destructive',
		surface: 'bg-destructive/10 border-destructive/50',
		surfaceText: 'text-foreground',
	},
	muted: {
		tone: 'muted',
		dot: 'bg-muted-foreground/40',
		text: 'text-muted-foreground',
		surface: 'bg-muted/50 border-border',
		surfaceText: 'text-muted-foreground',
	},
}

/** Extra emphasis for a bar or tile that is over its turn, late or at risk. */
export const ATTENTION_RING = 'ring-2 ring-warning/30'
/** Surface for something that is gone or closed (cancelled, blocked). */
export const GONE_SURFACE = 'border-dashed border-border text-muted-foreground'

function style(
	tone: StatusTone,
	badge: StatusBadgeVariant,
	label: MessageDescriptor,
	options?: { strike?: boolean; surface?: string },
): StatusStyle {
	const base = TONES[tone]
	return {
		...base,
		surface: options?.surface ?? base.surface,
		badge,
		label,
		strike: options?.strike ?? false,
	}
}

/** Statuses the API can send beyond the state-machine list (legacy rows, old clients). */
const LEGACY_RESERVATION_STATUSES = [
	'pending_approval',
	'disputed',
	'completed',
] as const

export type ReservationStatusKey =
	| (typeof RESERVATION_STATUSES)[number]
	| (typeof LEGACY_RESERVATION_STATUSES)[number]

/** Every status the host stand can meet, from `@repo/reservations` plus the legacy ones. */
export const ALL_RESERVATION_STATUSES: readonly ReservationStatusKey[] = [
	...RESERVATION_STATUSES,
	...LEGACY_RESERVATION_STATUSES,
]

const GONE = { strike: true, surface: `bg-transparent ${GONE_SURFACE}` }

export const RESERVATION_STATUS_STYLES: Record<
	ReservationStatusKey,
	StatusStyle
> = {
	requested: style('warning', 'warning', msg`Pending approval`),
	pending_approval: style('warning', 'warning', msg`Pending approval`),
	pending_payment: style('warning', 'warning', msg`Pending payment`),
	booked: style('neutral', 'secondary', msg`Booked`),
	confirmed: style('neutral', 'secondary', msg`Confirmed`),
	partially_arrived: style('primary', 'default', msg`Partly arrived`),
	arrived: style('primary', 'default', msg`Arrived`),
	partially_seated: style('primary', 'default', msg`Partially seated`),
	seated: style('success', 'success', msg`Seated`),
	finished: style('muted', 'outline', msg`Finished`),
	completed: style('muted', 'outline', msg`Completed`),
	cancelled: style('muted', 'outline', msg`Cancelled`, GONE),
	no_show: style('destructive', 'destructive', msg`No-show`, GONE),
	declined: style('muted', 'outline', msg`Declined`, GONE),
	expired: style('muted', 'outline', msg`Expired`, GONE),
	disputed: style('destructive', 'destructive', msg`Disputed`),
}

/** Live table states, including the ones the floor derives on the client. */
export const TABLE_STATE_KEYS = [
	'available',
	'open',
	'reserved_soon',
	'arrived_waiting',
	'seated',
	'entree',
	'dessert',
	'dessert_check',
	'check_dropped',
	'finishing',
	'overtime',
	'bussing',
	'blocked',
] as const
export type TableStateKey = (typeof TABLE_STATE_KEYS)[number]

const AVAILABLE_STYLE = style('neutral', 'secondary', msg`Available`)

export const TABLE_STATE_STYLES: Record<TableStateKey, StatusStyle> = {
	available: AVAILABLE_STYLE,
	open: AVAILABLE_STYLE,
	reserved_soon: style('neutral', 'secondary', msg`Reserved soon`, {
		surface: 'bg-card border-primary/40',
	}),
	arrived_waiting: style('primary', 'default', msg`Arrived, waiting`),
	seated: style('success', 'success', msg`Seated`),
	entree: style('success', 'success', msg`Entree`),
	dessert: style('success', 'success', msg`Dessert`),
	dessert_check: style('success', 'success', msg`Dessert / check`),
	check_dropped: style('success', 'success', msg`Check dropped`),
	finishing: style('success', 'success', msg`Finishing`, {
		surface: `bg-success/10 border-success/40 ${ATTENTION_RING}`,
	}),
	overtime: style('warning', 'warning', msg`Overtime`, {
		surface: `bg-warning/12 border-warning/40 ${ATTENTION_RING}`,
	}),
	bussing: style('muted', 'outline', msg`Bussing`),
	blocked: style('muted', 'outline', msg`Blocked`, {
		surface: 'bg-muted border-dashed border-border',
	}),
}

export const WAITLIST_STATUS_KEYS = [
	'waiting',
	'notified',
	'on_the_way',
	'seated',
	'cancelled',
	'left',
	'no_response',
] as const
export type WaitlistStatusKey = (typeof WAITLIST_STATUS_KEYS)[number]

export const WAITLIST_STATE_STYLES: Record<WaitlistStatusKey, StatusStyle> = {
	waiting: style('neutral', 'secondary', msg`Waiting`),
	notified: style('warning', 'warning', msg`Notified`),
	on_the_way: style('success', 'success', msg`On the way`),
	seated: style('success', 'success', msg`Seated`),
	cancelled: style('muted', 'outline', msg`Cancelled`, GONE),
	left: style('muted', 'outline', msg`Left`, GONE),
	no_response: style('destructive', 'destructive', msg`No response`, GONE),
}

const FALLBACK = style('neutral', 'secondary', msg`Unknown`)

export type StatusKind = 'reservation' | 'table' | 'waitlist'

const MAPS: Record<StatusKind, Record<string, StatusStyle>> = {
	reservation: RESERVATION_STATUS_STYLES,
	table: TABLE_STATE_STYLES,
	waitlist: WAITLIST_STATE_STYLES,
}

/** The style for a status; an unknown value falls back to neutral instead of throwing. */
export function statusStyle(kind: StatusKind, status: string): StatusStyle {
	return MAPS[kind][status] ?? FALLBACK
}

export const reservationStatusStyle = (status: string) =>
	statusStyle('reservation', status)
export const tableStateStyle = (status: string) => statusStyle('table', status)
export const waitlistStateStyle = (status: string) =>
	statusStyle('waitlist', status)

/** Dot plus plain text, the Staff pattern (`staff-status.tsx`). */
export function StatusLabel({
	kind = 'reservation',
	status,
	className,
	testId,
}: {
	kind?: StatusKind
	status: string
	className?: string
	testId?: string
}) {
	const { _ } = useLingui()
	const s = statusStyle(kind, status)
	return (
		<span
			className={cn(
				'inline-flex items-center gap-1.5 text-xs whitespace-nowrap',
				s.text,
				className,
			)}
			data-testid={testId}
			data-status-tone={s.tone}
		>
			<span aria-hidden="true" className={cn('size-1.5 rounded-full', s.dot)} />
			{_(s.label)}
		</span>
	)
}
