import { act, renderHook } from '@testing-library/react-native'
import { AppState, type AppStateStatus } from 'react-native'
import { type LoyaltyStore } from '../../lib/loyalty/loyalty-store'
import { useLoyaltyActivity } from './use-loyalty-activity'

function fakeStore() {
	return {
		start: jest.fn(),
		setActive: jest.fn(),
		refresh: jest.fn(async () => undefined),
	}
}

type Fake = ReturnType<typeof fakeStore>

describe('useLoyaltyActivity', () => {
	let listener: ((state: AppStateStatus) => void) | null = null
	let current: AppStateStatus = 'active'

	beforeEach(() => {
		listener = null
		Object.defineProperty(AppState, 'currentState', {
			configurable: true,
			get: () => current,
		})
		jest.spyOn(AppState, 'addEventListener').mockImplementation(((
			_type: string,
			handler: (state: AppStateStatus) => void,
		) => {
			listener = handler
			return { remove: jest.fn() }
		}) as never)
	})

	afterEach(() => {
		jest.restoreAllMocks()
		current = 'active'
	})

	function mount(store: Fake, focused = true) {
		return renderHook(
			(props: { focused: boolean }) =>
				useLoyaltyActivity(store as unknown as LoyaltyStore, props.focused),
			{ initialProps: { focused } },
		)
	}

	it('is active at launch while the app is in the foreground', () => {
		const store = fakeStore()
		mount(store)

		expect(store.start).toHaveBeenCalledTimes(1)
		expect(store.setActive).toHaveBeenLastCalledWith(true)
	})

	it('treats a launch in the background as inactive', () => {
		current = 'background'
		const store = fakeStore()
		mount(store)

		expect(store.setActive).toHaveBeenLastCalledWith(false)
	})

	it('reads the foreground the same way at launch and on a change', () => {
		const store = fakeStore()
		mount(store)

		// iOS reports `inactive` while a system sheet is up: still foreground.
		act(() => listener?.('inactive'))
		expect(store.setActive).toHaveBeenLastCalledWith(true)

		act(() => listener?.('background'))
		expect(store.setActive).toHaveBeenLastCalledWith(false)
		expect(store.refresh).not.toHaveBeenCalled()

		act(() => listener?.('active'))
		expect(store.setActive).toHaveBeenLastCalledWith(true)
		expect(store.refresh).toHaveBeenCalledTimes(1)
	})

	it('stays inactive while the tab is not focused', () => {
		const store = fakeStore()
		const view = mount(store, false)
		expect(store.setActive).toHaveBeenLastCalledWith(false)

		view.rerender({ focused: true })
		expect(store.setActive).toHaveBeenLastCalledWith(true)
		expect(store.refresh).toHaveBeenCalledTimes(1)
	})
})
