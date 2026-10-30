import { I18nProvider } from '@lingui/react'
import { render } from '@testing-library/react-native'
import { type ReactElement } from 'react'
import { type StubReply, StubTransport } from './stub-transport'
import { makeAccessToken, makeConfiguration } from './support'
import { type HttpRequest } from '@/lib/api/http'
import { AppProvider } from '@/lib/app/app-provider'
import { createAppStore } from '@/lib/app/create-app-store'
import { type TenantConfiguration } from '@/lib/config/configuration'
import { activateLocale, i18n } from '@/lib/i18n/lingui'
import { createMemoryTokenStorage } from '@/lib/session/token-storage'
import { createMemoryPreferences } from '@/lib/state/preferences'
import { type SiteAddress } from '@/lib/support/site-address'

export type Route = StubReply | ((request: HttpRequest) => StubReply)

export const ORGANIZATION = {
	id: 'org_1',
	name: 'Acme Coffee',
	slug: 'acme',
	dataRegion: 'us',
	locales: ['en', 'ar'],
	defaultLocale: 'en',
	theme: { theme: 'amber', radius: 'large', mode: 'light' },
	announcements: [] as unknown[],
}

export const PROFILE = {
	customer: {
		id: 'cust_1',
		name: 'Ada Lovelace',
		email: 'ada@example.com',
		phone: '+15550001111',
	},
}

export const SIGNED_IN = {
	accessToken: makeAccessToken(),
	refreshToken: 'refresh_1',
}

/** Replies by path; the last reply of a path repeats. */
export function routeTransport(
	table: Record<string, Route | Route[]>,
): StubTransport {
	const queues = new Map<string, Route[]>()
	for (const [path, route] of Object.entries(table)) {
		queues.set(path, Array.isArray(route) ? [...route] : [route])
	}
	return new StubTransport((request) => {
		const path = new URL(request.url).pathname
		const queue = queues.get(path)
		const route = queue && queue.length > 1 ? queue.shift() : queue?.[0]
		if (!route) return { status: 404, raw: '{"error":"Not Found"}' }
		return typeof route === 'function' ? route(request) : route
	})
}

export function makeApp(
	table: Record<string, Route | Route[]>,
	options: {
		configuration?: TenantConfiguration
		tokens?: { accessToken: string; refreshToken: string } | null
		language?: string | null
		/** The site an un-branded install connected to earlier. */
		site?: SiteAddress | null
	} = {},
) {
	activateLocale('en')
	const transport = routeTransport(table)
	const preferences = createMemoryPreferences({
		language: options.language ?? null,
		site: options.site ?? null,
	})
	const store = createAppStore({
		configuration: options.configuration ?? makeConfiguration(),
		preferences,
		tokenStorage: createMemoryTokenStorage(options.tokens ?? null),
		transport: transport.send,
	})
	return { store, transport, preferences }
}

/** A screen under the store, with the catalog, but without the shell. */
export function renderWithStore(
	store: ReturnType<typeof makeApp>['store'],
	element: ReactElement,
) {
	return render(
		<AppProvider store={store}>
			<I18nProvider i18n={i18n}>{element}</I18nProvider>
		</AppProvider>,
	)
}
