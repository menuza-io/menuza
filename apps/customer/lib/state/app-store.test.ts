import { type HttpRequest } from '../api/http'
import { type TenantConfiguration } from '../config/configuration'
import { createMemoryTokenStorage } from '../session/token-storage'
import { makeSiteAddress, type SiteAddress } from '../support/site-address'
import { AppStore, type CustomerFeature } from './app-store'
import { createMemoryPreferences } from './preferences'
import { sleep, type StubReply, StubTransport } from '@/test/stub-transport'
import { makeAccessToken, makeConfiguration } from '@/test/support'

type Route = StubReply | ((request: HttpRequest) => StubReply)

const ORGANIZATION = {
	id: 'org_1',
	name: 'Acme Coffee',
	slug: 'acme',
	dataRegion: 'us',
	locales: ['en', 'ar'],
	defaultLocale: 'en',
	theme: { theme: 'amber', radius: 'large', mode: 'light' },
	announcements: [{ id: 'ann_1', content: 'Free delivery', type: 'info' }],
}

const PROFILE = {
	customer: { id: 'cust_1', name: 'Ada Lovelace', phone: '+15550001111' },
}

function routes(table: Record<string, Route | Route[]>) {
	const queues = new Map<string, Route[]>()
	for (const [path, route] of Object.entries(table)) {
		queues.set(path, Array.isArray(route) ? [...route] : [route])
	}
	return new StubTransport((request) => {
		const path = new URL(request.url).pathname
		const queue = queues.get(path)
		// The last reply of a path repeats.
		const route = queue && queue.length > 1 ? queue.shift() : queue?.[0]
		if (!route) return { status: 404, raw: 'Not Found' }
		return typeof route === 'function' ? route(request) : route
	})
}

function fakeFeature(): CustomerFeature & {
	reset: jest.Mock
	dispose: jest.Mock
} {
	return { reset: jest.fn(), dispose: jest.fn() }
}

function makeStore(
	transport: StubTransport,
	options: {
		build?: TenantConfiguration
		stored?: SiteAddress | null
		language?: string | null
		tokens?: { accessToken: string; refreshToken: string } | null
		device?: string[]
		prepareStorage?: () => Promise<unknown>
		forgetSiteData?: () => Promise<unknown>
	} = {},
) {
	const preferences = createMemoryPreferences({
		site: options.stored ?? null,
		language: options.language ?? null,
	})
	const tokenStorage = createMemoryTokenStorage(options.tokens ?? null)
	const features: Array<ReturnType<typeof fakeFeature>> = []
	const store = new AppStore({
		configuration: options.build ?? makeConfiguration(),
		preferences,
		tokenStorage,
		deviceLanguages: () => options.device ?? ['en-US'],
		transport: transport.send,
		prepareStorage: options.prepareStorage,
		forgetSiteData: options.forgetSiteData,
		createFeatures: () => {
			const rewards = fakeFeature()
			features.push(rewards)
			return { rewards }
		},
	})
	return { store, preferences, tokenStorage, features }
}

async function until(predicate: () => boolean, label = 'condition') {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (predicate()) return
		await sleep(2)
	}
	throw new Error(`Timed out waiting for ${label}`)
}

const unbound = () => makeConfiguration({ slug: null, host: null })

describe('AppStore', () => {
	describe('starting', () => {
		it('prepares storage before it reads the site, the language or the session', async () => {
			const transport = routes({ '/resources/sites': { json: ORGANIZATION } })
			const order: string[] = []
			const { store, preferences, tokenStorage } = makeStore(transport, {
				stored: makeSiteAddress({ slug: 'acme' }),
				language: 'de',
				tokens: { accessToken: makeAccessToken(), refreshToken: 'refresh-1' },
				build: unbound(),
				prepareStorage: async () => {
					order.push('prepare')
					// What a reinstall wipe does: nothing of the old install is left.
					await preferences.saveSiteAddress(null)
					await preferences.saveLanguageOverride(null)
					await tokenStorage.save(null)
				},
			})

			await store.start()

			expect(order).toEqual(['prepare'])
			expect(store.getSnapshot().phase).toEqual({ kind: 'needsSite' })
			expect(store.getSnapshot().languageOverride).toBeNull()
			expect(store.getSnapshot().isSignedIn).toBe(false)
			expect(transport.recorded).toHaveLength(0)
		})

		it('still starts when preparing storage fails', async () => {
			const transport = routes({ '/resources/sites': { json: ORGANIZATION } })
			const { store } = makeStore(transport, {
				prepareStorage: async () => {
					throw new Error('keychain')
				},
			})

			await store.start()

			expect(store.getSnapshot().phase).toEqual({ kind: 'ready' })
		})
	})

	describe('using a different site', () => {
		it('signs out with a revocation, forgets the site and its booking codes, and asks for a site', async () => {
			const transport = routes({
				'/resources/sites': { json: ORGANIZATION },
				'/auth/me': { json: PROFILE },
				'/auth/logout': { json: { success: true } },
			})
			const forgetSiteData = jest.fn(async () => undefined)
			const { store, preferences, tokenStorage, features } = makeStore(
				transport,
				{
					build: unbound(),
					stored: makeSiteAddress({ slug: 'acme' }),
					tokens: { accessToken: makeAccessToken(), refreshToken: 'refresh-1' },
					forgetSiteData,
				},
			)
			await store.start()
			expect(store.getSnapshot().canChangeSite).toBe(true)
			expect(store.getSnapshot().isSignedIn).toBe(true)

			await store.leaveSite()

			const snapshot = store.getSnapshot()
			expect(snapshot.phase).toEqual({ kind: 'needsSite' })
			expect(snapshot.organization).toBeNull()
			expect(snapshot.session).toBeNull()
			expect(snapshot.features).toBeNull()
			expect(snapshot.isSignedIn).toBe(false)
			expect(snapshot.profile).toBeNull()
			expect(snapshot.configuration.siteAddress).toEqual(makeSiteAddress({}))
			expect(preferences.site).toBeNull()
			expect(tokenStorage.current).toBeNull()
			expect(features[0]?.reset).toHaveBeenCalled()
			expect(features[0]?.dispose).toHaveBeenCalled()
			expect(forgetSiteData).toHaveBeenCalledTimes(1)
			await until(() => transport.paths.includes('/auth/logout'), 'revocation')
		})

		it('leaves a site that does not load, clearing the stored session on the device', async () => {
			const transport = routes({
				'/resources/sites': { status: 503, json: { error: 'unavailable' } },
			})
			const forgetSiteData = jest.fn(async () => undefined)
			const { store, preferences, tokenStorage } = makeStore(transport, {
				build: unbound(),
				stored: makeSiteAddress({ slug: 'acme' }),
				tokens: { accessToken: makeAccessToken(), refreshToken: 'refresh-1' },
				forgetSiteData,
			})
			await store.start()
			expect(store.getSnapshot().phase.kind).toBe('failed')

			await store.leaveSite()

			expect(store.getSnapshot().phase).toEqual({ kind: 'needsSite' })
			expect(preferences.site).toBeNull()
			expect(tokenStorage.current).toBeNull()
			expect(forgetSiteData).toHaveBeenCalledTimes(1)
		})

		it('ignores an answer of the site it left', async () => {
			const transport = routes({
				'/resources/sites': { json: ORGANIZATION, delayMs: 20 },
			})
			const { store } = makeStore(transport, {
				build: unbound(),
				stored: makeSiteAddress({ slug: 'acme' }),
			})
			const started = store.start()
			await until(
				() => transport.paths.includes('/resources/sites'),
				'site request',
			)

			await store.leaveSite()
			await started
			await sleep(30)

			expect(store.getSnapshot().phase).toEqual({ kind: 'needsSite' })
			expect(store.getSnapshot().organization).toBeNull()
		})

		it('cannot leave the site a white-label build is bound to', async () => {
			const transport = routes({ '/resources/sites': { json: ORGANIZATION } })
			const forgetSiteData = jest.fn(async () => undefined)
			const { store } = makeStore(transport, { forgetSiteData })
			await store.start()
			expect(store.getSnapshot().canChangeSite).toBe(false)

			await store.leaveSite()

			expect(store.getSnapshot().phase).toEqual({ kind: 'ready' })
			expect(store.getSnapshot().organization?.id).toBe('org_1')
			expect(forgetSiteData).not.toHaveBeenCalled()
		})
	})

	describe('connecting a site', () => {
		it('asks for a site when neither the build nor the customer chose one', async () => {
			const transport = routes({})
			const { store } = makeStore(transport, { build: unbound() })

			await store.start()

			expect(store.getSnapshot().phase).toEqual({ kind: 'needsSite' })
			expect(transport.recorded).toHaveLength(0)
		})

		it('loads the site the build is bound to and forgets an address typed earlier', async () => {
			const transport = routes({ '/resources/sites': { json: ORGANIZATION } })
			const { store, preferences } = makeStore(transport, {
				stored: { slug: 'other', host: null, origin: null },
			})

			await store.start()

			const snapshot = store.getSnapshot()
			expect(snapshot.phase).toEqual({ kind: 'ready' })
			expect(snapshot.organization?.name).toBe('Acme Coffee')
			expect(snapshot.theme.themeName).toBe('amber')
			expect(snapshot.theme.mode).toBe('light')
			expect(snapshot.isSignedIn).toBe(false)
			expect(snapshot.session).not.toBeNull()
			expect(transport.lastRequest?.url.searchParams.get('slug')).toBe('acme')
			expect(preferences.site).toBeNull()
		})

		it('loads the site an un-branded install connected to before', async () => {
			const transport = routes({ '/resources/sites': { json: ORGANIZATION } })
			const { store } = makeStore(transport, {
				build: unbound(),
				stored: {
					slug: 'acme',
					host: null,
					origin: 'https://acme.epic-startup.com',
				},
			})

			await store.start()

			expect(store.getSnapshot().phase).toEqual({ kind: 'ready' })
			expect(transport.lastRequest?.url.searchParams.get('slug')).toBe('acme')
		})

		it('refuses an address it cannot read without calling the server', async () => {
			const transport = routes({})
			const { store } = makeStore(transport, { build: unbound() })
			await store.start()

			await store.connect('not a site!')

			expect(store.getSnapshot().error).toEqual({ reason: 'siteNotFound' })
			expect(store.getSnapshot().phase).toEqual({ kind: 'needsSite' })
			expect(transport.recorded).toHaveLength(0)
		})

		it('keeps asking, and stores nothing, when the site does not exist', async () => {
			const transport = routes({
				'/resources/sites': { status: 404, raw: 'Not Found' },
			})
			const { store, preferences } = makeStore(transport, { build: unbound() })
			await store.start()

			const connecting = store.connect('nope')
			expect(store.getSnapshot().isConnecting).toBe(true)
			await connecting

			const snapshot = store.getSnapshot()
			expect(snapshot.isConnecting).toBe(false)
			expect(snapshot.phase).toEqual({ kind: 'needsSite' })
			expect(snapshot.error).toEqual({ reason: 'siteNotFound' })
			expect(preferences.site).toBeNull()
			expect(snapshot.configuration.siteAddress.slug).toBeNull()
		})

		it('says so when the device is offline', async () => {
			const transport = new StubTransport(() => {
				throw new TypeError('Network request failed')
			})
			const { store } = makeStore(transport, { build: unbound() })
			await store.start()

			await store.connect('acme')

			expect(store.getSnapshot().error).toEqual({ reason: 'network' })
		})

		it('stores the address only once the site loads', async () => {
			const transport = routes({ '/resources/sites': { json: ORGANIZATION } })
			const { store, preferences } = makeStore(transport, { build: unbound() })
			await store.start()

			await store.connect('https://acme.epic-startup.com/menu')

			expect(store.getSnapshot().phase).toEqual({ kind: 'ready' })
			expect(preferences.site).toEqual({
				slug: 'acme',
				host: null,
				origin: 'https://acme.epic-startup.com',
			})
			expect(store.getSnapshot().configuration.siteAddress.slug).toBe('acme')
		})

		it('connects a typed custom domain over https in a build that requires TLS', async () => {
			const transport = routes({ '/resources/sites': { json: ORGANIZATION } })
			const { store, preferences } = makeStore(transport, { build: unbound() })
			await store.start()

			await store.connect('http://www.acme.com')

			expect(store.getSnapshot().phase).toEqual({ kind: 'ready' })
			expect(preferences.site).toEqual({
				slug: null,
				host: 'www.acme.com',
				origin: 'https://www.acme.com',
			})
		})

		it('shows a failure for a bound site and loads it again on retry', async () => {
			const transport = routes({
				'/resources/sites': [
					{ status: 503, raw: '{"error":"Unavailable"}' },
					{ json: ORGANIZATION },
				],
			})
			const { store } = makeStore(transport)

			await store.start()
			expect(store.getSnapshot().phase).toEqual({
				kind: 'failed',
				error: { reason: 'unavailable' },
			})

			await store.retry()
			expect(store.getSnapshot().phase).toEqual({ kind: 'ready' })
		})

		it('never sends a KSA site to another region when this build has no KSA node', async () => {
			const transport = routes({
				'/resources/sites': { json: { ...ORGANIZATION, dataRegion: 'ksa' } },
			})
			const { store, preferences } = makeStore(transport, {
				build: { ...unbound(), tenantApiBaseUrlKsa: null },
			})
			await store.start()

			await store.connect('acme')

			expect(store.getSnapshot().error).toEqual({ reason: 'regionUnavailable' })
			expect(store.getSnapshot().phase).toEqual({ kind: 'needsSite' })
			expect(preferences.site).toBeNull()
		})

		it('signs KSA customers in on the KSA node', async () => {
			const transport = routes({
				'/resources/sites': { json: { ...ORGANIZATION, dataRegion: 'ksa' } },
				'/auth/send-code': { json: { success: true } },
			})
			const { store } = makeStore(transport)
			await store.start()

			await store.sendCode('+966 50 000 1111')

			expect(transport.lastRequest?.url.host).toBe(
				'tenant-ksa.epic-startup.com',
			)
			expect(store.getSnapshot().configuration.dataRegion).toBe('ksa')
		})

		it('passes the device languages and the chosen language to the site', async () => {
			const transport = routes({ '/resources/sites': { json: ORGANIZATION } })
			const { store } = makeStore(transport, {
				device: ['fr-FR', 'en-US'],
				language: 'ar',
			})

			await store.start()

			const request = transport.lastRequest
			expect(request?.url.searchParams.get('lng')).toBe('ar')
			expect(request?.request.headers['Accept-Language']).toBe('fr-FR, en-US')
		})
	})

	describe('the stored session', () => {
		it('restores the session of this organization and loads the profile', async () => {
			const transport = routes({
				'/resources/sites': { json: ORGANIZATION },
				'/auth/me': { json: PROFILE },
			})
			const { store } = makeStore(transport, {
				tokens: { accessToken: makeAccessToken(), refreshToken: 'refresh-1' },
			})

			await store.start()

			expect(store.getSnapshot().isSignedIn).toBe(true)
			await until(
				() => store.getSnapshot().profileStatus === 'loaded',
				'profile',
			)
			expect(store.getSnapshot().profile?.name).toBe('Ada Lovelace')
		})

		it('drops a session of another organization on the device only', async () => {
			const transport = routes({ '/resources/sites': { json: ORGANIZATION } })
			const { store, tokenStorage, features } = makeStore(transport, {
				tokens: {
					accessToken: makeAccessToken({ orgId: 'org_other' }),
					refreshToken: 'r-other',
				},
			})

			await store.start()

			expect(store.getSnapshot().isSignedIn).toBe(false)
			expect(tokenStorage.current).toBeNull()
			// That organization's refresh token must not reach this node.
			expect(transport.paths).toEqual(['/resources/sites'])
			expect(features[0]?.reset).toHaveBeenCalled()
		})

		it('returns to sign-in when the session can no longer be refreshed', async () => {
			const transport = routes({
				'/resources/sites': { json: ORGANIZATION },
				'/auth/me': {
					status: 401,
					raw: '{"error":"Invalid or expired token"}',
				},
				'/auth/refresh': {
					status: 401,
					raw: '{"error":"Invalid refresh token"}',
				},
			})
			const { store, features } = makeStore(transport, {
				tokens: { accessToken: makeAccessToken(), refreshToken: 'refresh-1' },
			})

			await store.start()
			await until(() => !store.getSnapshot().isSignedIn, 'sign-out')

			const snapshot = store.getSnapshot()
			expect(snapshot.profile).toBeNull()
			expect(snapshot.error).toEqual({ reason: 'signedOut' })
			expect(features[0]?.reset).toHaveBeenCalled()
		})

		it('returns to sign-in when the organization is no longer active', async () => {
			const transport = routes({
				'/resources/sites': { json: ORGANIZATION },
				'/auth/me': {
					status: 401,
					raw: '{"error":"Invalid or expired token"}',
				},
				'/auth/refresh': {
					status: 403,
					json: {
						error: 'Organization is no longer active',
						code: 'organization_inactive',
					},
				},
			})
			const { store, features } = makeStore(transport, {
				tokens: { accessToken: makeAccessToken(), refreshToken: 'refresh-1' },
			})

			await store.start()
			await until(() => !store.getSnapshot().isSignedIn, 'sign-out')

			const snapshot = store.getSnapshot()
			expect(snapshot.profile).toBeNull()
			expect(snapshot.error).toEqual({ reason: 'signedOut' })
			expect(features[0]?.reset).toHaveBeenCalled()
		})

		it('keeps the customer signed in when a control-plane outage answers the refresh with a bare 403', async () => {
			const transport = routes({
				'/resources/sites': { json: ORGANIZATION },
				'/auth/me': {
					status: 401,
					raw: '{"error":"Invalid or expired token"}',
				},
				'/auth/refresh': {
					status: 403,
					json: { error: 'Organization is no longer active' },
				},
			})
			const { store } = makeStore(transport, {
				tokens: { accessToken: makeAccessToken(), refreshToken: 'refresh-1' },
			})

			await store.start()
			await until(
				() => transport.paths.includes('/auth/refresh'),
				'refresh attempt',
			)
			await until(() => store.getSnapshot().error !== null, 'error')

			expect(store.getSnapshot().isSignedIn).toBe(true)
		})

		it('keeps the customer signed in when the profile fails for a transient reason', async () => {
			const transport = routes({
				'/resources/sites': { json: ORGANIZATION },
				'/auth/me': [
					{ status: 500, raw: '{"error":"Internal Server Error"}' },
					{ json: PROFILE },
				],
			})
			const { store } = makeStore(transport, {
				tokens: { accessToken: makeAccessToken(), refreshToken: 'refresh-1' },
			})

			await store.start()
			await until(
				() => store.getSnapshot().profileStatus === 'failed',
				'profile failure',
			)
			expect(store.getSnapshot().isSignedIn).toBe(true)
			expect(store.getSnapshot().error).toEqual({ reason: 'unavailable' })

			await store.loadProfile()
			expect(store.getSnapshot().profileStatus).toBe('loaded')
		})
	})

	describe('signing in', () => {
		async function ready(table: Record<string, Route | Route[]>) {
			const transport = routes({
				'/resources/sites': { json: ORGANIZATION },
				...table,
			})
			const made = makeStore(transport)
			await made.store.start()
			return { transport, ...made }
		}

		it('checks the phone number before sending a code', async () => {
			const { store, transport } = await ready({})

			await store.sendCode('12')

			expect(store.getSnapshot().error).toEqual({ reason: 'invalidPhone' })
			expect(store.getSnapshot().pendingPhone).toBeNull()
			expect(transport.paths).toEqual(['/resources/sites'])
		})

		it('sends a code and remembers the normalized number', async () => {
			const { store, transport } = await ready({
				'/auth/send-code': { json: { success: true } },
			})

			const sending = store.sendCode('+1 (555) 000-1111')
			expect(store.getSnapshot().isBusy).toBe(true)
			await sending

			expect(store.getSnapshot().isBusy).toBe(false)
			expect(store.getSnapshot().pendingPhone).toBe('+15550001111')
			expect(transport.lastRequest?.body.phone).toBe('+15550001111')
		})

		it('says when there were too many attempts', async () => {
			const { store } = await ready({
				'/auth/send-code': {
					status: 429,
					json: { error: 'rate_limit_exceeded' },
				},
			})

			await store.sendCode('+15550001111')

			expect(store.getSnapshot().error).toEqual({ reason: 'rateLimited' })
			expect(store.getSnapshot().pendingPhone).toBeNull()
		})

		it('signs in with the code, starts the features over and loads the profile', async () => {
			const { store, features } = await ready({
				'/auth/send-code': { json: { success: true } },
				'/auth/verify': {
					json: {
						success: true,
						accessToken: makeAccessToken(),
						refreshToken: 'r',
						needsName: false,
					},
				},
				'/auth/me': { json: PROFILE },
			})
			await store.sendCode('+15550001111')

			await store.verify(' 123456 ')

			const snapshot = store.getSnapshot()
			expect(snapshot.isSignedIn).toBe(true)
			expect(snapshot.needsName).toBe(false)
			expect(snapshot.pendingPhone).toBeNull()
			expect(snapshot.profile?.name).toBe('Ada Lovelace')
			expect(features[0]?.reset).toHaveBeenCalledTimes(1)
		})

		it('asks a new customer for a name', async () => {
			const { store, transport } = await ready({
				'/auth/send-code': { json: { success: true } },
				'/auth/verify': {
					json: {
						success: true,
						accessToken: makeAccessToken(),
						refreshToken: 'r',
						needsName: true,
					},
				},
				'/auth/profile': {
					json: {
						success: true,
						accessToken: makeAccessToken({ name: 'Grace Hopper' }),
						refreshToken: 'refresh-2',
					},
				},
				'/auth/me': {
					json: { customer: { id: 'cust_1', name: 'Grace Hopper' } },
				},
			})
			await store.sendCode('+15550001111')
			await store.verify('123456')
			expect(store.getSnapshot().needsName).toBe(true)
			expect(transport.paths).not.toContain('/auth/me')

			await store.completeName('G')
			expect(store.getSnapshot().error).toEqual({ reason: 'nameRequired' })

			await store.completeName('Grace Hopper')
			expect(store.getSnapshot().needsName).toBe(false)
			expect(store.getSnapshot().profile?.name).toBe('Grace Hopper')
		})

		it('keeps the code screen with a wrong code', async () => {
			const { store } = await ready({
				'/auth/send-code': { json: { success: true } },
				'/auth/verify': {
					status: 400,
					json: { error: 'Invalid or expired code' },
				},
			})
			await store.sendCode('+15550001111')

			await store.verify('000000')

			expect(store.getSnapshot().error).toEqual({ reason: 'invalidCode' })
			expect(store.getSnapshot().pendingPhone).toBe('+15550001111')
			expect(store.getSnapshot().isSignedIn).toBe(false)
		})

		it('does not sign in when the customer backs out while the code is checked', async () => {
			const { store, transport, tokenStorage } = await ready({
				'/auth/send-code': { json: { success: true } },
				'/auth/verify': {
					json: {
						success: true,
						accessToken: makeAccessToken(),
						refreshToken: 'r-late',
					},
					delayMs: 40,
				},
				'/auth/logout': { json: { success: true } },
			})
			await store.sendCode('+15550001111')

			const verifying = store.verify('123456')
			store.cancelVerification()
			await verifying

			expect(store.getSnapshot().isSignedIn).toBe(false)
			expect(store.getSnapshot().pendingPhone).toBeNull()
			expect(store.getSnapshot().isBusy).toBe(false)
			expect(tokenStorage.current).toBeNull()
			await until(() => transport.paths.includes('/auth/logout'), 'revocation')
		})

		it('tells the customer a new code is on its way', async () => {
			const { store, transport } = await ready({
				'/auth/send-code': { json: { success: true } },
			})
			await store.sendCode('+15550001111')

			await store.resendCode()

			expect(store.getSnapshot().didResendCode).toBe(true)
			expect(
				transport.paths.filter((path) => path === '/auth/send-code'),
			).toHaveLength(2)
			store.clearTransientMessages()
			expect(store.getSnapshot().didResendCode).toBe(false)
		})

		it('signs out on the device, starts the features over and revokes the session', async () => {
			const { store, transport, tokenStorage, features } = await ready({
				'/auth/send-code': { json: { success: true } },
				'/auth/verify': {
					json: {
						success: true,
						accessToken: makeAccessToken(),
						refreshToken: 'r',
					},
				},
				'/auth/me': { json: PROFILE },
				'/auth/logout': { json: { success: true } },
			})
			await store.sendCode('+15550001111')
			await store.verify('123456')

			await store.signOut()

			const snapshot = store.getSnapshot()
			expect(snapshot.isSignedIn).toBe(false)
			expect(snapshot.profile).toBeNull()
			expect(snapshot.error).toBeNull()
			expect(tokenStorage.current).toBeNull()
			expect(features[0]?.reset).toHaveBeenCalledTimes(2)
			await until(() => transport.paths.includes('/auth/logout'), 'revocation')
		})
	})

	describe('the profile', () => {
		async function signedIn(table: Record<string, Route | Route[]>) {
			const transport = routes({
				'/resources/sites': { json: ORGANIZATION },
				'/auth/me': { json: PROFILE },
				...table,
			})
			const made = makeStore(transport, {
				tokens: { accessToken: makeAccessToken(), refreshToken: 'refresh-1' },
			})
			await made.store.start()
			await until(
				() => made.store.getSnapshot().profileStatus === 'loaded',
				'profile',
			)
			return { transport, ...made }
		}

		it('saves the name and email', async () => {
			const { store, transport } = await signedIn({
				'/auth/profile': {
					json: {
						success: true,
						accessToken: makeAccessToken({ name: 'Ada Byron' }),
						refreshToken: 'refresh-2',
					},
				},
			})

			await store.saveProfile('Ada Byron', 'ada@example.com')

			expect(store.getSnapshot().didSaveProfile).toBe(true)
			expect(store.getSnapshot().isSavingProfile).toBe(false)
			expect(
				transport.recorded.find(
					(entry) => entry.url.pathname === '/auth/profile',
				)?.body,
			).toEqual({
				name: 'Ada Byron',
				email: 'ada@example.com',
			})
		})

		it('checks the email before saving', async () => {
			const { store, transport } = await signedIn({})

			await store.saveProfile('Ada Byron', 'not-an-email')

			expect(store.getSnapshot().error).toEqual({ reason: 'invalidEmail' })
			expect(transport.paths).not.toContain('/auth/profile')
		})

		it('clears the email when the field is emptied', async () => {
			const { store, transport } = await signedIn({
				'/auth/profile': {
					json: {
						success: true,
						accessToken: makeAccessToken(),
						refreshToken: 'refresh-2',
					},
				},
			})

			await store.saveProfile('Ada Lovelace', '  ')

			expect(
				transport.recorded.find(
					(entry) => entry.url.pathname === '/auth/profile',
				)?.body,
			).toEqual({
				name: 'Ada Lovelace',
				email: '',
			})
		})
	})

	describe('language', () => {
		it('follows the device when the app has that translation', async () => {
			const transport = routes({ '/resources/sites': { json: ORGANIZATION } })
			const { store } = makeStore(transport, { device: ['fr-CA'] })

			await store.start()

			expect(store.getSnapshot().language.code).toBe('fr')
		})

		it('falls back to the language of the site', async () => {
			const transport = routes({
				'/resources/sites': {
					json: { ...ORGANIZATION, locale: 'ar', defaultLocale: 'ar' },
				},
			})
			const { store } = makeStore(transport, { device: ['ja-JP'] })

			await store.start()

			expect(store.getSnapshot().language).toEqual({
				code: 'ar',
				isRtl: true,
				displayName: 'Arabic',
			})
		})

		it('keeps the customer choice and reloads the site content in it', async () => {
			const transport = routes({
				'/resources/sites': [
					{ json: ORGANIZATION },
					{
						json: {
							...ORGANIZATION,
							announcements: [
								{ id: 'ann_1', content: 'توصيل مجاني', type: 'info' },
							],
						},
					},
				],
			})
			const { store, preferences } = makeStore(transport)
			await store.start()

			await store.setLanguageOverride('ar')

			expect(store.getSnapshot().language.code).toBe('ar')
			expect(store.getSnapshot().languageOverride).toBe('ar')
			expect(preferences.language).toBe('ar')
			await until(
				() =>
					store.getSnapshot().organization?.announcements?.[0]?.content ===
					'توصيل مجاني',
				'translated content',
			)
			expect(transport.lastRequest?.url.searchParams.get('lng')).toBe('ar')

			await store.setLanguageOverride(null)
			expect(store.getSnapshot().language.code).toBe('en')
			expect(preferences.language).toBeNull()
		})

		it('ignores a stored language the app does not ship', async () => {
			const transport = routes({ '/resources/sites': { json: ORGANIZATION } })
			const { store } = makeStore(transport, { language: 'xx' })

			await store.start()

			expect(store.getSnapshot().languageOverride).toBeNull()
			expect(store.getSnapshot().language.code).toBe('en')
		})
	})

	it('hands React the same snapshot until something changes', async () => {
		const transport = routes({ '/resources/sites': { json: ORGANIZATION } })
		const { store } = makeStore(transport)
		const listener = jest.fn()
		store.subscribe(listener)

		const before = store.getSnapshot()
		expect(store.getSnapshot()).toBe(before)
		await store.start()

		expect(store.getSnapshot()).not.toBe(before)
		expect(listener).toHaveBeenCalled()
	})

	it('disposes the features when it is disposed', async () => {
		const transport = routes({ '/resources/sites': { json: ORGANIZATION } })
		const { store, features } = makeStore(transport)
		await store.start()

		store.dispose()

		expect(features[0]?.dispose).toHaveBeenCalled()
	})
})
