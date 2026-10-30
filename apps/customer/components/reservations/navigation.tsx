import { createContext, useContext, type ReactNode } from 'react'
import { type BookingPhase } from '../../lib/reservations/booking-flow'

/** A screen of the reservations stack above home. */
export type ReservationsRoute =
	| {
			readonly name:
				| 'location'
				| 'search'
				| 'details'
				| 'review'
				| 'payment'
				| 'confirmed'
				| 'waitlist'
	  }
	| { readonly name: 'detail'; readonly id: string }

export type ReservationsRouteName = ReservationsRoute['name']

type StaticRouteName = Exclude<ReservationsRouteName, 'detail'>

export function route(name: StaticRouteName): ReservationsRoute {
	return { name }
}

export function detailRoute(id: string): ReservationsRoute {
	return { name: 'detail', id }
}

export function sameRoute(a: ReservationsRoute, b: ReservationsRoute): boolean {
	if (a.name !== b.name) return false
	return a.name !== 'detail' || b.name !== 'detail' || a.id === b.id
}

/**
 * What the reservation screens need from the navigator. Home is the root of
 * the stack and never part of `stack()`.
 */
export type ReservationsNavigation = {
	/** The routes above home, bottom first, as they are now. */
	stack(): readonly ReservationsRoute[]
	push(route: ReservationsRoute): void
	back(): void
	/** Leaves exactly these routes above home: pops what differs, then pushes what is missing. */
	resetTo(routes: readonly ReservationsRoute[]): void
}

/** How many routes from the bottom both stacks share. */
export function sharedDepth(
	current: readonly ReservationsRoute[],
	target: readonly ReservationsRoute[],
): number {
	let depth = 0
	while (
		depth < current.length &&
		depth < target.length &&
		sameRoute(current[depth]!, target[depth]!)
	) {
		depth += 1
	}
	return depth
}

export type PhaseAlertKey = 'rsv.pay.expired' | 'rsv.error.holdExpired'

export type PhaseFollow = {
	/** The stack to move to; `null` leaves it alone. */
	readonly stack: readonly ReservationsRoute[] | null
	readonly alert: PhaseAlertKey | null
}

const BOOKING_STEPS = new Set<ReservationsRouteName>([
	'details',
	'review',
	'payment',
])

function has(
	stack: readonly ReservationsRoute[],
	name: ReservationsRouteName,
): boolean {
	return stack.some((entry) => entry.name === name)
}

function withSearch(stack: ReservationsRoute[]): ReservationsRoute[] {
	return has(stack, 'search') ? stack : [...stack, route('search')]
}

/**
 * Keeps the stack in step with the booking flow, so a back gesture, an
 * expired hold or a taken time always lands on the right screen. The same
 * rules as the iOS `ReservationsShell.follow`.
 */
export function followPhase(
	phase: BookingPhase,
	stack: readonly ReservationsRoute[],
): PhaseFollow {
	const none: PhaseFollow = { stack: null, alert: null }
	switch (phase.kind) {
		case 'details':
			return has(stack, 'details')
				? none
				: { stack: [...stack, route('details')], alert: null }
		case 'reviewing':
			return has(stack, 'review')
				? none
				: { stack: [...stack, route('review')], alert: null }
		case 'awaitingPayment':
			return has(stack, 'payment')
				? none
				: { stack: [...stack, route('payment')], alert: null }
		case 'confirmed':
		case 'requested':
			if (has(stack, 'confirmed')) return none
			return {
				stack: [
					...stack.filter((entry) => !BOOKING_STEPS.has(entry.name)),
					route('confirmed'),
				],
				alert: null,
			}
		case 'expired': {
			// The hold ran out (or the payment window closed): back to the times.
			if (!stack.some((entry) => BOOKING_STEPS.has(entry.name))) return none
			return {
				stack: withSearch(
					stack.filter((entry) => !BOOKING_STEPS.has(entry.name)),
				),
				alert: has(stack, 'payment')
					? 'rsv.pay.expired'
					: 'rsv.error.holdExpired',
			}
		}
		case 'failed':
			if (phase.failure.kind !== 'slotUnavailable') return none
			if (!has(stack, 'details') && !has(stack, 'review')) return none
			return {
				stack: withSearch(
					stack.filter(
						(entry) => entry.name !== 'details' && entry.name !== 'review',
					),
				),
				alert: null,
			}
		default:
			return none
	}
}

const NavigationContext = createContext<ReservationsNavigation | null>(null)

export function ReservationsNavigationProvider({
	navigation,
	children,
}: {
	navigation: ReservationsNavigation
	children: ReactNode
}) {
	return (
		<NavigationContext.Provider value={navigation}>
			{children}
		</NavigationContext.Provider>
	)
}

export function useReservationsNavigation(): ReservationsNavigation {
	const navigation = useContext(NavigationContext)
	if (!navigation) {
		throw new Error(
			'useReservationsNavigation must be used under ReservationsNavigationProvider',
		)
	}
	return navigation
}
