import { I18nProvider } from '@lingui/react'
import { act, render, renderHook } from '@testing-library/react-native'
import { type ReactElement } from 'react'
import {
	hrefFor,
	reservationsStackFromState,
	useExpoReservationsNavigation,
} from './expo-navigation'
import {
	detailRoute,
	followPhase,
	ReservationsNavigationProvider,
	route,
	sharedDepth,
} from './navigation'
import { ReservationsController } from './reservations-controller'
import { AppProvider } from '@/lib/app/app-provider'
import { i18n } from '@/lib/i18n/lingui'
import { fixtureJson } from '@/test/reservations/fixtures'
import {
	settle,
	startReservationsApp,
	TestNavigation,
} from '@/test/reservations/screens'

const mockRouter = {
	push: jest.fn(),
	back: jest.fn(),
	canGoBack: jest.fn(() => true),
	canDismiss: jest.fn(() => true),
	dismissTo: jest.fn(),
	dismissAll: jest.fn(),
}
let mockRootState: unknown = undefined

jest.mock('expo-router', () => ({
	useRouter: () => mockRouter,
	useRootNavigationState: () => mockRootState,
	useFocusEffect: () => undefined,
}))

const search = route('search')
const details = route('details')
const review = route('review')
const payment = route('payment')
const confirmed = route('confirmed')

describe('followPhase', () => {
	it('pushes each booking step once', () => {
		expect(followPhase({ kind: 'details' }, [search])).toEqual({
			stack: [search, details],
			alert: null,
		})
		expect(followPhase({ kind: 'details' }, [search, details]).stack).toBeNull()
		expect(followPhase({ kind: 'reviewing' }, [search, details]).stack).toEqual(
			[search, details, review],
		)
		expect(
			followPhase({ kind: 'awaitingPayment' }, [search, details, review]).stack,
		).toEqual([search, details, review, payment])
	})

	it('replaces the booking steps with the confirmation', () => {
		for (const kind of ['confirmed', 'requested'] as const) {
			expect(followPhase({ kind }, [search, details, review, payment])).toEqual(
				{
					stack: [search, confirmed],
					alert: null,
				},
			)
		}
		expect(
			followPhase({ kind: 'confirmed' }, [search, confirmed]).stack,
		).toBeNull()
	})

	it('goes back to the times with an alert when a hold or a payment window runs out', () => {
		expect(followPhase({ kind: 'expired' }, [search, details, review])).toEqual(
			{
				stack: [search],
				alert: 'rsv.error.holdExpired',
			},
		)
		expect(
			followPhase({ kind: 'expired' }, [search, details, review, payment]),
		).toEqual({
			stack: [search],
			alert: 'rsv.pay.expired',
		})
		expect(followPhase({ kind: 'expired' }, [details])).toEqual({
			stack: [search],
			alert: 'rsv.error.holdExpired',
		})
		// Nothing to leave: no alert either.
		expect(followPhase({ kind: 'expired' }, [search])).toEqual({
			stack: null,
			alert: null,
		})
	})

	it('goes back to the times when the chosen time was taken, and stays for other failures', () => {
		expect(
			followPhase(
				{
					kind: 'failed',
					failure: {
						kind: 'slotUnavailable',
						alternatives: { sameDay: [], otherDates: [] },
					},
				},
				[search, details, review],
			),
		).toEqual({ stack: [search], alert: null })
		expect(
			followPhase({ kind: 'failed', failure: { kind: 'offline' } }, [
				search,
				details,
				review,
			]).stack,
		).toBeNull()
		expect(followPhase({ kind: 'idle' }, [search]).stack).toBeNull()
	})
})

describe('sharedDepth', () => {
	it('counts the routes both stacks start with', () => {
		expect(sharedDepth([search, details, review], [search, confirmed])).toBe(1)
		expect(sharedDepth([detailRoute('a')], [detailRoute('b')])).toBe(0)
		expect(sharedDepth([detailRoute('a')], [detailRoute('a')])).toBe(1)
		expect(sharedDepth([], [search])).toBe(0)
	})
})

describe('expo-router binding', () => {
	beforeEach(() => {
		for (const fn of Object.values(mockRouter)) fn.mockClear()
		mockRootState = undefined
	})

	it('reads the reservations stack out of the root state', () => {
		const state = {
			routes: [
				{
					name: '(tabs)',
					state: {
						routes: [
							{ name: 'rewards' },
							{
								name: 'reservations',
								state: {
									routes: [
										{ name: 'index' },
										{ name: 'search' },
										{ name: '[id]', params: { id: 'rsv_1' } },
									],
								},
							},
						],
					},
				},
			],
		}
		expect(reservationsStackFromState(state)).toEqual([
			search,
			detailRoute('rsv_1'),
		])
		expect(reservationsStackFromState(undefined)).toEqual([])
	})

	it('links each route', () => {
		expect(hrefFor(search)).toBe('/reservations/search')
		expect(hrefFor(detailRoute('rsv_1'))).toEqual({
			pathname: '/reservations/[id]',
			params: { id: 'rsv_1' },
		})
	})

	it('pops back to the shared route, then pushes the rest', () => {
		mockRootState = {
			routes: [
				{
					name: 'reservations',
					state: {
						routes: [
							{ name: 'index' },
							{ name: 'search' },
							{ name: 'details' },
							{ name: 'review' },
						],
					},
				},
			],
		}
		const { result } = renderHook(() => useExpoReservationsNavigation())
		expect(result.current.stack()).toEqual([search, details, review])
		result.current.resetTo([search, confirmed])
		expect(mockRouter.dismissTo).toHaveBeenCalledWith('/reservations/search')
		expect(mockRouter.push).toHaveBeenCalledWith('/reservations/confirmed')
		expect(result.current.stack()).toEqual([search, confirmed])

		result.current.resetTo([])
		expect(mockRouter.dismissAll).toHaveBeenCalledTimes(1)

		result.current.push(detailRoute('rsv_1'))
		expect(mockRouter.push).toHaveBeenLastCalledWith({
			pathname: '/reservations/[id]',
			params: { id: 'rsv_1' },
		})
		result.current.back()
		expect(mockRouter.back).toHaveBeenCalledTimes(1)
	})
})

describe('ReservationsController', () => {
	function wrap(
		app: Awaited<ReturnType<typeof startReservationsApp>>,
		element: ReactElement,
	) {
		return (
			<AppProvider store={app.store}>
				<I18nProvider i18n={i18n}>{element}</I18nProvider>
			</AppProvider>
		)
	}

	it('loads the configuration and waits for its tab before following the flow', async () => {
		const app = await startReservationsApp({
			'/reservations/config': { json: fixtureJson('config') },
			'/reservations/availability': { json: fixtureJson('availability') },
			'/reservations/holds': { json: fixtureJson('hold') },
		})
		const navigation = new TestNavigation([search])
		const controller = (focused: boolean) =>
			wrap(
				app,
				<ReservationsNavigationProvider navigation={navigation}>
					<ReservationsController focused={focused} />
				</ReservationsNavigationProvider>,
			)
		const view = render(controller(false))
		await settle()
		expect(app.reservations.getSnapshot().loadState.kind).toBe('ready')

		const slot = fixtureJson('availability').slots.find(
			(entry) => entry.time === '19:00',
		)!
		await act(async () => {
			await app.reservations.search()
			await app.reservations.choose(slot)
		})
		expect(app.reservations.getSnapshot().flow.phase.kind).toBe('details')
		// Another tab is in front: moving now would pull the guest back here.
		expect(navigation.names).toEqual(['search'])

		view.rerender(controller(true))
		expect(navigation.names).toEqual(['search', 'details'])
		await settle()
	})
})
