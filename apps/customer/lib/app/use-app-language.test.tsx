import { i18n } from '@lingui/core'
import TestRenderer, { act } from 'react-test-renderer'
import { createMemoryTokenStorage } from '../session/token-storage'
import { createMemoryPreferences } from '../state/preferences'
import { AppProvider } from './app-provider'
import { createAppStore } from './create-app-store'
import { useAppLanguageSync } from './use-app-language'
import { StubTransport } from '@/test/stub-transport'
import { makeConfiguration } from '@/test/support'

const ORGANIZATION = {
	id: 'org_1',
	name: 'Acme Coffee',
	slug: 'acme',
	dataRegion: 'us',
	locales: ['en', 'de'],
	defaultLocale: 'en',
	theme: { theme: 'amber', radius: 'large', mode: 'light' },
	announcements: [],
}

describe('useAppLanguageSync', () => {
	it('activates the resolved locale and feeds it to the reservations feature', async () => {
		const transport = new StubTransport(() => ({ json: ORGANIZATION }))
		const store = createAppStore({
			configuration: makeConfiguration(),
			preferences: createMemoryPreferences(),
			tokenStorage: createMemoryTokenStorage(null),
			transport: transport.send,
			deviceLanguages: () => ['de-DE'],
		})
		await store.start()
		let rendered: string | null = null
		function Probe() {
			rendered = useAppLanguageSync().code
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

		expect(rendered).toBe('de')
		expect(i18n.locale).toBe('de')
		expect(
			store.getSnapshot().features?.reservations.getSnapshot().localeCode,
		).toBe('de')
		await act(async () => renderer!.unmount())
	})
})
