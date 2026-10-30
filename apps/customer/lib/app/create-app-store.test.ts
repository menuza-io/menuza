import { LoyaltyStore } from '../loyalty/loyalty-store'
import { ReservationsStore } from '../reservations/reservations-store'
import { createMemoryTokenStorage } from '../session/token-storage'
import { createMemoryPreferences } from '../state/preferences'
import { createAppStore } from './create-app-store'
import { flush } from '@/test/reservations/manual-clock'
import { StubTransport } from '@/test/stub-transport'
import { makeAccessToken, makeConfiguration } from '@/test/support'

const ORGANIZATION = {
	id: 'org_1',
	name: 'Acme Coffee',
	slug: 'acme',
	dataRegion: 'us',
	locales: ['en', 'de', 'ar'],
	defaultLocale: 'en',
	theme: { theme: 'amber', radius: 'large', mode: 'light' },
	announcements: [],
}

function routes(table: Record<string, unknown>) {
	return new StubTransport((request) => {
		const body = table[new URL(request.url).pathname]
		if (!body) return { status: 404, raw: 'Not Found' }
		return typeof body === 'object' && body !== null && 'status' in body
			? (body as { status: number })
			: { json: body }
	})
}

function makeStore(transport: StubTransport, signedIn = false) {
	return createAppStore({
		configuration: makeConfiguration(),
		preferences: createMemoryPreferences(),
		tokenStorage: createMemoryTokenStorage(
			signedIn
				? { accessToken: makeAccessToken(), refreshToken: 'refresh-1' }
				: null,
		),
		transport: transport.send,
	})
}

describe('createAppStore', () => {
	it('creates the reservations and loyalty features once the site is ready', async () => {
		const transport = routes({ '/resources/sites': ORGANIZATION })
		const store = makeStore(transport)

		await store.start()

		const snapshot = store.getSnapshot()
		expect(snapshot.phase).toEqual({ kind: 'ready' })
		expect(snapshot.features?.reservations).toBeInstanceOf(ReservationsStore)
		expect(snapshot.features?.loyalty).toBeInstanceOf(LoyaltyStore)
		// The features see the resolved language and the session of this site.
		expect(snapshot.features?.reservations.getSnapshot().localeCode).toBe('en')
		expect(snapshot.features?.loyalty.getSnapshot().status).toBe('loading')
	})

	it('signs the app out when loyalty finds the session is dead', async () => {
		const transport = routes({
			'/resources/sites': ORGANIZATION,
			'/loyalty/wallet': {
				status: 403,
				json: { error: 'organization_mismatch', code: 'organization_mismatch' },
			},
		})
		const store = makeStore(transport, true)
		await store.start()
		expect(store.getSnapshot().isSignedIn).toBe(true)

		store.getSnapshot().features?.loyalty.start()
		await flush()

		expect(store.getSnapshot().isSignedIn).toBe(false)
	})

	it('starts the reservations feature in the resolved language', async () => {
		const transport = routes({ '/resources/sites': ORGANIZATION })
		const store = createAppStore({
			configuration: makeConfiguration(),
			preferences: createMemoryPreferences(),
			tokenStorage: createMemoryTokenStorage(null),
			transport: transport.send,
			deviceLanguages: () => ['de-DE'],
		})

		await store.start()

		expect(store.getSnapshot().language.code).toBe('de')
		expect(
			store.getSnapshot().features?.reservations.getSnapshot().localeCode,
		).toBe('de')
	})
})
