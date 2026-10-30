import {
	type Href,
	useFocusEffect,
	useRootNavigationState,
	useRouter,
} from 'expo-router'
import { useCallback, useMemo, useRef, useState } from 'react'
import {
	type ReservationsNavigation,
	type ReservationsRoute,
	sharedDepth,
} from './navigation'

/** The tab (and folder) that holds the reservations stack. */
const STACK_NAME = 'reservations'

const STATIC_ROUTES = new Set([
	'location',
	'search',
	'details',
	'review',
	'payment',
	'confirmed',
	'waitlist',
])

type NavigationRoute = {
	readonly name: string
	readonly params?: object
	readonly state?: NavigationState
}

type NavigationState = { readonly routes?: readonly NavigationRoute[] }

function routeFrom(entry: NavigationRoute): ReservationsRoute | null {
	if (entry.name === '[id]') {
		const id = (entry.params as { id?: unknown } | undefined)?.id
		return typeof id === 'string' && id !== '' ? { name: 'detail', id } : null
	}
	if (STATIC_ROUTES.has(entry.name))
		return { name: entry.name } as ReservationsRoute
	return null
}

function stackRoutes(
	state: NavigationState | null | undefined,
): readonly NavigationRoute[] | null {
	for (const entry of state?.routes ?? []) {
		if (entry.name === STACK_NAME) return entry.state?.routes ?? []
		const nested = stackRoutes(entry.state)
		if (nested) return nested
	}
	return null
}

/**
 * The routes of the reservations stack above home, read out of the root
 * navigation state (tabs, then the reservations stack). A stack that was
 * never navigated has no state yet: just home.
 */
export function reservationsStackFromState(
	state: NavigationState | null | undefined,
): ReservationsRoute[] {
	return (stackRoutes(state) ?? [])
		.map(routeFrom)
		.filter((value): value is ReservationsRoute => value !== null)
}

export function hrefFor(target: ReservationsRoute): Href {
	if (target.name === 'detail') {
		return { pathname: '/reservations/[id]', params: { id: target.id } }
	}
	return `/reservations/${target.name}`
}

/** `ReservationsNavigation` over expo-router, for the reservations stack layout. */
export function useExpoReservationsNavigation(): ReservationsNavigation {
	const router = useRouter()
	const rootState = useRootNavigationState() as NavigationState | undefined
	const stackRef = useRef<readonly ReservationsRoute[]>([])
	stackRef.current = reservationsStackFromState(rootState)
	return useMemo<ReservationsNavigation>(
		() => ({
			stack: () => stackRef.current,
			push: (target) => {
				router.push(hrefFor(target))
				stackRef.current = [...stackRef.current, target]
			},
			back: () => {
				if (router.canGoBack()) router.back()
			},
			resetTo: (routes) => {
				const current = stackRef.current
				const depth = sharedDepth(current, routes)
				if (depth < current.length) {
					const base = current[depth - 1]
					if (base) router.dismissTo(hrefFor(base))
					else if (router.canDismiss()) router.dismissAll()
				}
				for (const target of routes.slice(depth)) router.push(hrefFor(target))
				stackRef.current = [...routes]
			},
		}),
		[router],
	)
}

/** Whether the route that calls it is the focused screen (its tab focused too). */
export function useRouteFocus(): boolean {
	const [focused, setFocused] = useState(true)
	useFocusEffect(
		useCallback(() => {
			setFocused(true)
			return () => setFocused(false)
		}, []),
	)
	return focused
}
