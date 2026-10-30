import { I18nProvider } from '@lingui/react'
import { act, render, waitFor } from '@testing-library/react-native'
import { useSyncExternalStore } from 'react'
import { View } from 'react-native'
import {
	ORGANIZATION,
	PROFILE,
	type Route,
	routeTransport,
	SIGNED_IN,
} from '../app-harness'
import { makeConfiguration } from '../support'
import { flush, ManualClock } from './manual-clock'
import { ReservationConfirmedScreen } from '@/components/reservations/confirmed-screen'
import { ReservationDetailScreen } from '@/components/reservations/detail-screen'
import { ReservationDetailsScreen } from '@/components/reservations/details-screen'
import { ReservationsHomeScreen } from '@/components/reservations/home-screen'
import { ReservationLocationScreen } from '@/components/reservations/location-screen'
import {
	type ReservationsNavigation,
	ReservationsNavigationProvider,
	type ReservationsRoute,
} from '@/components/reservations/navigation'
import { ReservationPaymentScreen } from '@/components/reservations/payment-screen'
import { ReservationsController } from '@/components/reservations/reservations-controller'
import { ReservationReviewScreen } from '@/components/reservations/review-screen'
import { ReservationSearchScreen } from '@/components/reservations/search-screen'
import { ReservationWaitlistScreen } from '@/components/reservations/waitlist-screen'
import { AppProvider } from '@/lib/app/app-provider'
import { type AppFeatures } from '@/lib/app/features'
import { activateLocale, APP_LOCALES, i18n } from '@/lib/i18n/lingui'
import { LoyaltyStore } from '@/lib/loyalty/loyalty-store'
import { ReservationsClient } from '@/lib/reservations/reservations-client'
import { ReservationsStore } from '@/lib/reservations/reservations-store'
import {
	createMemoryReservationTokenStore,
	type StoredReservationTokens,
} from '@/lib/reservations/token-store'
import { createMemoryTokenStorage } from '@/lib/session/token-storage'
import { AppStore } from '@/lib/state/app-store'
import { createMemoryPreferences } from '@/lib/state/preferences'

/**
 * An in-memory stack for the reservation screens: what expo-router does on
 * the device, without a navigator. Every screen of the stack stays mounted
 * (as in a native stack); only the top one is focused and visible to queries.
 */
export class TestNavigation implements ReservationsNavigation {
	#stack: readonly ReservationsRoute[]
	readonly #listeners = new Set<() => void>()

	constructor(initial: readonly ReservationsRoute[] = []) {
		this.#stack = initial
	}

	readonly stack = (): readonly ReservationsRoute[] => this.#stack

	readonly push = (target: ReservationsRoute): void =>
		this.#set([...this.#stack, target])

	readonly back = (): void => this.#set(this.#stack.slice(0, -1))

	readonly resetTo = (routes: readonly ReservationsRoute[]): void =>
		this.#set([...routes])

	readonly subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener)
		return () => {
			this.#listeners.delete(listener)
		}
	}

	/** The stack above home as names (`detail:<id>` for a reservation). */
	get names(): string[] {
		return this.#stack.map((entry) =>
			entry.name === 'detail' ? `detail:${entry.id}` : entry.name,
		)
	}

	#set(next: readonly ReservationsRoute[]): void {
		this.#stack = next
		for (const listener of this.#listeners) listener()
	}
}

function screenFor(entry: ReservationsRoute | null, focused: boolean) {
	if (entry === null) return <ReservationsHomeScreen focused={focused} />
	switch (entry.name) {
		case 'location':
			return <ReservationLocationScreen />
		case 'search':
			return <ReservationSearchScreen focused={focused} />
		case 'details':
			return <ReservationDetailsScreen focused={focused} />
		case 'review':
			return <ReservationReviewScreen />
		case 'payment':
			return <ReservationPaymentScreen focused={focused} />
		case 'confirmed':
			return <ReservationConfirmedScreen focused={focused} />
		case 'waitlist':
			return <ReservationWaitlistScreen focused={focused} />
		case 'detail':
			return <ReservationDetailScreen id={entry.id} />
	}
}

function keyFor(entry: ReservationsRoute | null, index: number): string {
	if (entry === null) return 'home'
	return `${index}:${entry.name}${entry.name === 'detail' ? `:${entry.id}` : ''}`
}

/** Home, the screens above it and the controller, like the reservations tab layout. */
function TestStack({ navigation }: { navigation: TestNavigation }) {
	const stack = useSyncExternalStore(navigation.subscribe, navigation.stack)
	const layers: Array<ReservationsRoute | null> = [null, ...stack]
	return (
		<ReservationsNavigationProvider navigation={navigation}>
			<ReservationsController />
			{layers.map((entry, index) => {
				const top = index === layers.length - 1
				return (
					<View
						key={keyFor(entry, index)}
						accessibilityElementsHidden={!top}
						importantForAccessibility={top ? 'auto' : 'no-hide-descendants'}
					>
						{screenFor(entry, top)}
					</View>
				)
			})}
		</ReservationsNavigationProvider>
	)
}

export type ReservationsAppOptions = {
	/** Starts at the device's real time by default; the server clock comes from the answers. */
	clock?: ManualClock
	tokens?: StoredReservationTokens
}

/**
 * A signed-in app whose reservations store runs on a hand-moved clock, with
 * the browser and the phone dialer replaced by recorders. Routes are answered
 * by path like `makeApp`; the site and the profile are answered already.
 */
export async function startReservationsApp(
	table: Record<string, Route | Route[]>,
	options: ReservationsAppOptions = {},
) {
	activateLocale('en')
	const transport = routeTransport({
		'/resources/sites': { json: ORGANIZATION },
		'/auth/me': { json: PROFILE },
		...table,
	})
	const clock = options.clock ?? new ManualClock(Date.now())
	const tokens = createMemoryReservationTokenStore(options.tokens)
	const openBrowser = jest.fn(async (ignoredUrl: string) => undefined)
	const openUrl = jest.fn(async (ignoredUrl: string) => undefined)
	let keys = 0
	const store = new AppStore<AppFeatures>({
		configuration: makeConfiguration(),
		preferences: createMemoryPreferences({ language: null }),
		tokenStorage: createMemoryTokenStorage(SIGNED_IN),
		deviceLanguages: () => ['en-US'],
		appLocales: APP_LOCALES,
		transport: transport.send,
		createFeatures: (context) => ({
			reservations: new ReservationsStore({
				client: new ReservationsClient(context.session, { platform: 'ios' }),
				tokens,
				localeCode: context.language().code,
				now: clock.now,
				timers: clock.timers,
				openBrowser,
				openUrl,
				makeKey: () => {
					keys += 1
					return `key-${keys}`
				},
			}),
			loyalty: new LoyaltyStore({ session: context.session, platform: 'ios' }),
		}),
	})
	await store.start()
	await waitFor(() => {
		expect(store.getSnapshot().profileStatus).toBe('loaded')
	})
	const reservations = store.getSnapshot().features?.reservations
	if (!reservations)
		throw new Error('The signed-in app has no reservations store')
	return { store, reservations, transport, clock, tokens, openBrowser, openUrl }
}

export type ReservationsApp = Awaited<ReturnType<typeof startReservationsApp>>

/** The reservations tab of `app`, with `initial` above home. */
export function renderReservations(
	app: ReservationsApp,
	initial: readonly ReservationsRoute[] = [],
) {
	const navigation = new TestNavigation(initial)
	const view = render(
		<AppProvider store={app.store}>
			<I18nProvider i18n={i18n}>
				<TestStack navigation={navigation} />
			</I18nProvider>
		</AppProvider>,
	)
	return { navigation, ...view }
}

/** Lets the answers still on their way (a list refresh, a token lookup) arrive inside `act`. */
export async function settle(): Promise<void> {
	await act(async () => {
		await flush()
	})
}

/** The requests sent to `path`, oldest first. */
export function sentTo(app: ReservationsApp, path: string) {
	return app.transport.recorded.filter((entry) => entry.url.pathname === path)
}
