import TestRenderer, { act } from 'react-test-renderer'
import { AppProvider } from '../app/app-provider'
import { createAppStore } from '../app/create-app-store'
import { createMemoryTokenStorage } from '../session/token-storage'
import { createMemoryPreferences } from '../state/preferences'
import { type UniwindThemeRuntime } from './apply-theme'
import { useApplySiteTheme } from './use-site-theme'
import { StubTransport } from '@/test/stub-transport'
import { makeConfiguration } from '@/test/support'

const ORGANIZATION = {
	id: 'org_1',
	name: 'Acme Coffee',
	slug: 'acme',
	dataRegion: 'us',
	locales: ['en'],
	defaultLocale: 'en',
	theme: { theme: 'amber', radius: 'large', mode: 'dark' },
	announcements: [],
}

function makeRuntime(): UniwindThemeRuntime & {
	variables: Record<string, Record<string, string | number>>
	modes: string[]
} {
	const variables: Record<string, Record<string, string | number>> = {}
	const modes: string[] = []
	return {
		variables,
		modes,
		updateCSSVariables(theme, next) {
			variables[theme] = next
		},
		setTheme(mode) {
			modes.push(mode)
		},
	}
}

describe('useApplySiteTheme', () => {
	it('pushes the organization theme into both schemes and selects its mode', async () => {
		const transport = new StubTransport(() => ({ json: ORGANIZATION }))
		const store = createAppStore({
			configuration: makeConfiguration(),
			preferences: createMemoryPreferences(),
			tokenStorage: createMemoryTokenStorage(null),
			transport: transport.send,
		})
		await store.start()
		const runtime = makeRuntime()
		function Probe({ rt }: { rt: ReturnType<typeof makeRuntime> }) {
			useApplySiteTheme(rt)
			return null
		}

		let renderer: TestRenderer.ReactTestRenderer
		await act(async () => {
			renderer = TestRenderer.create(
				<AppProvider store={store}>
					<Probe rt={runtime} />
				</AppProvider>,
			)
		})

		expect(Object.keys(runtime.variables).sort()).toEqual(['dark', 'light'])
		expect(runtime.variables.light?.['--color-primary']).toBeTruthy()
		expect(runtime.variables.light?.['--radius-lg']).toBeTruthy()
		expect(runtime.modes).toEqual(['dark'])
		await act(async () => renderer!.unmount())
	})
})
