import TestRenderer, { act } from 'react-test-renderer'
import { createMemoryTokenStorage } from '../session/token-storage'
import { type AppStore } from '../state/app-store'
import { createMemoryPreferences } from '../state/preferences'
import { AppProvider } from './app-provider'
import { createAppStore } from './create-app-store'
import { type AppFeatures } from './features'
import {
	useAppSnapshot,
	useAppStore,
	useLoyalty,
	useReservations,
	useSiteTheme,
} from './use-app'
import { StubTransport } from '@/test/stub-transport'
import { makeConfiguration } from '@/test/support'

const ORGANIZATION = {
	id: 'org_1',
	name: 'Acme Coffee',
	slug: 'acme',
	dataRegion: 'us',
	locales: ['en'],
	defaultLocale: 'en',
	theme: { theme: 'amber', radius: 'large', mode: 'light' },
	announcements: [],
}

type Seen = {
	phase: string
	themeName: string | null
	hasReservations: boolean
	hasLoyalty: boolean
	reservationsLocale: string | null
}

async function readyStore(): Promise<AppStore<AppFeatures>> {
	const transport = new StubTransport(() => ({ json: ORGANIZATION }))
	const store = createAppStore({
		configuration: makeConfiguration(),
		preferences: createMemoryPreferences(),
		tokenStorage: createMemoryTokenStorage(null),
		transport: transport.send,
	})
	await store.start()
	return store
}

describe('app hooks', () => {
	it('exposes the snapshot, theme and features under the provider', async () => {
		const store = await readyStore()
		const seen: Seen[] = []
		function Probe() {
			const snapshot = useAppSnapshot()
			const theme = useSiteTheme()
			const reservations = useReservations()
			const loyalty = useLoyalty()
			seen.push({
				phase: snapshot.phase.kind,
				themeName: theme.themeName,
				hasReservations: reservations !== null,
				hasLoyalty: loyalty !== null,
				reservationsLocale: reservations?.snapshot.localeCode ?? null,
			})
			return null
		}

		let renderer: TestRenderer.ReactTestRenderer
		await act(async () => {
			renderer = TestRenderer.create(
				<AppProvider store={store}>
					<Probe />
				</AppProvider>,
			)
		})

		const last = seen.at(-1)
		expect(last).toEqual({
			phase: 'ready',
			themeName: 'amber',
			hasReservations: true,
			hasLoyalty: true,
			reservationsLocale: 'en',
		})
		await act(async () => renderer!.unmount())
	})

	it('starts the store the provider is given', async () => {
		const transport = new StubTransport(() => ({ json: ORGANIZATION }))
		const store = createAppStore({
			configuration: makeConfiguration(),
			preferences: createMemoryPreferences(),
			tokenStorage: createMemoryTokenStorage(null),
			transport: transport.send,
		})
		expect(store.getSnapshot().phase.kind).toBe('loading')

		let renderer: TestRenderer.ReactTestRenderer
		await act(async () => {
			renderer = TestRenderer.create(
				<AppProvider store={store}>
					<></>
				</AppProvider>,
			)
		})

		expect(store.getSnapshot().phase.kind).toBe('ready')
		await act(async () => renderer!.unmount())
	})

	it('throws for a screen rendered without the provider', async () => {
		let thrown: string | null = null
		function Bare() {
			try {
				useAppStore()
			} catch (error) {
				thrown = (error as Error).message
			}
			return null
		}
		await act(async () => {
			TestRenderer.create(<Bare />)
		})
		expect(thrown).toBe('useAppStore must be used under AppProvider')
	})
})
