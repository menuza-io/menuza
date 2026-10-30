import { ApiError, regionUnavailableError } from '../api/api-error'
import { fetchTransport, type HttpTransport } from '../api/http'
import {
	type CustomerProfile,
	type PublicOrganization,
	resolvedDataRegion,
} from '../api/public-site'
import { TenantApiClient } from '../api/tenant-api-client'
import {
	isBoundToTenant,
	type TenantConfiguration,
	tenantApiBaseUrl,
} from '../config/configuration'
import {
	type AppLanguage,
	CONTENT_LOCALES,
	normalizeLocale,
	resolveAppLanguage,
} from '../i18n/site-locale'
import { tokenOrgId } from '../session/auth-tokens'
import { CustomerSession } from '../session/customer-session'
import { type TokenStorage } from '../session/token-storage'
import { isValidPhone, normalizePhone } from '../support/phone-number'
import {
	isSiteBound,
	parseSiteAddress,
	resolveSiteAddress,
	type SiteAddress,
} from '../support/site-address'
import {
	FALLBACK_SITE_THEME,
	type SiteTheme,
	siteThemeFromPayload,
} from '../theme/site-theme'
import { type AppAction, type AppError, appErrorFrom } from './app-error'
import { type PreferencesStorage } from './preferences'

export type AppPhase =
	| { kind: 'loading' }
	/** No site bound yet: the customer connects one. */
	| { kind: 'needsSite' }
	| { kind: 'ready' }
	| { kind: 'failed'; error: AppError }

export type ProfileStatus = 'idle' | 'loading' | 'loaded' | 'failed'

/**
 * State that belongs to the signed-in customer (bookings, rewards). It starts
 * over whenever the customer changes, so nothing of one session reaches the next.
 */
export type CustomerFeature = {
	reset(): void
	dispose?(): void
}

export type CustomerFeatures = { readonly [name: string]: CustomerFeature }

export type FeatureContext = {
	session: CustomerSession
	configuration: TenantConfiguration
	organization: PublicOrganization
	/** The language the screens render in right now. */
	language: () => AppLanguage
}

export type AppSnapshot<Features extends CustomerFeatures> = {
	readonly phase: AppPhase
	readonly configuration: TenantConfiguration
	readonly organization: PublicOrganization | null
	readonly theme: SiteTheme
	readonly language: AppLanguage
	/** `null`: follow the device. */
	readonly languageOverride: string | null
	readonly availableLanguages: readonly string[]
	readonly isConnecting: boolean
	/** Un-branded builds only: the customer may leave this site for another. */
	readonly canChangeSite: boolean
	readonly isSignedIn: boolean
	readonly needsName: boolean
	/** Set once a code was sent: the customer is on the code step. */
	readonly pendingPhone: string | null
	readonly isBusy: boolean
	readonly didResendCode: boolean
	readonly profile: CustomerProfile | null
	readonly profileStatus: ProfileStatus
	readonly isSavingProfile: boolean
	readonly didSaveProfile: boolean
	readonly error: AppError | null
	readonly session: CustomerSession | null
	readonly features: Features | null
}

export type AppStoreOptions<Features extends CustomerFeatures> = {
	configuration: TenantConfiguration
	preferences: PreferencesStorage
	tokenStorage: TokenStorage
	deviceLanguages: () => readonly string[]
	/** Locales this build has translations for. */
	appLocales?: readonly string[]
	transport?: HttpTransport
	createFeatures?: (context: FeatureContext) => Features
	/** Runs once before anything is read from storage (the reinstall wipe). */
	prepareStorage?: () => Promise<unknown>
	/** Deletes the booking codes kept on the device when the customer leaves a site. */
	forgetSiteData?: () => Promise<unknown>
}

const NAME_MAX_LENGTH = 100
const EMAIL_MAX_LENGTH = 254
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function characters(value: string): number {
	return Array.from(value).length
}

/**
 * The app's single source of truth (the port of `AppState` in the native
 * apps): the site's branding, the customer session and the profile. Screens
 * read it with `useSyncExternalStore`; every action resolves once the state
 * reflects its outcome.
 */
export class AppStore<Features extends CustomerFeatures = CustomerFeatures> {
	readonly #preferences: PreferencesStorage
	readonly #tokenStorage: TokenStorage
	readonly #deviceLanguages: () => readonly string[]
	readonly #appLocales: readonly string[]
	readonly #transport: HttpTransport
	readonly #createFeatures: ((context: FeatureContext) => Features) | null
	readonly #prepareStorage: (() => Promise<unknown>) | null
	readonly #forgetSiteData: (() => Promise<unknown>) | null
	readonly #buildConfiguration: TenantConfiguration
	readonly #buildAddress: SiteAddress
	readonly #listeners = new Set<() => void>()
	#snapshot: AppSnapshot<Features>
	#client: TenantApiClient
	#started: Promise<void> | null = null
	/** Bumped by every site load, so an answer that lost a race is dropped. */
	#siteLoad = 0
	#contentLoad = 0
	/**
	 * Bumped whenever the sign-in attempt or the session ends, so a late answer
	 * cannot sign the customer in, or show an error, after they moved on.
	 */
	#authAttempt = 0
	#unsubscribeSession: (() => void) | null = null
	#disposed = false

	constructor(options: AppStoreOptions<Features>) {
		this.#preferences = options.preferences
		this.#tokenStorage = options.tokenStorage
		this.#deviceLanguages = options.deviceLanguages
		this.#appLocales = options.appLocales?.length
			? options.appLocales.map(normalizeLocale)
			: [...CONTENT_LOCALES]
		this.#transport = options.transport ?? fetchTransport
		this.#createFeatures = options.createFeatures ?? null
		this.#prepareStorage = options.prepareStorage ?? null
		this.#forgetSiteData = options.forgetSiteData ?? null
		this.#buildConfiguration = options.configuration
		this.#buildAddress = options.configuration.siteAddress
		this.#client = new TenantApiClient(options.configuration, this.#transport)
		this.#snapshot = {
			phase: { kind: 'loading' },
			configuration: options.configuration,
			organization: null,
			theme: FALLBACK_SITE_THEME,
			language: this.#resolveLanguage(null, null),
			languageOverride: null,
			availableLanguages: this.#appLocales,
			isConnecting: false,
			canChangeSite: !isSiteBound(options.configuration.siteAddress),
			isSignedIn: false,
			needsName: false,
			pendingPhone: null,
			isBusy: false,
			didResendCode: false,
			profile: null,
			profileStatus: 'idle',
			isSavingProfile: false,
			didSaveProfile: false,
			error: null,
			session: null,
			features: null,
		}
	}

	readonly subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener)
		return () => {
			this.#listeners.delete(listener)
		}
	}

	readonly getSnapshot = (): AppSnapshot<Features> => this.#snapshot

	// MARK: - Lifecycle

	/** Loads the preferences and the site; later calls share the first. */
	start(): Promise<void> {
		this.#started ??= this.#start()
		return this.#started
	}

	async #start(): Promise<void> {
		try {
			await this.#prepareStorage?.()
		} catch {
			// The app still starts; the stored state is read as it is.
		}
		const [stored, storedLanguage] = await Promise.all([
			this.#preferences.loadSiteAddress(),
			this.#preferences.loadLanguageOverride(),
		])
		if (this.#disposed) return
		// A white-label build is bound to one site at build time. That binding
		// wins over an address typed into an earlier un-branded install, so the
		// shipping app never asks for a site or points at another one.
		if (isSiteBound(this.#buildAddress) && stored) {
			await this.#preferences.saveSiteAddress(null)
		}
		const languageOverride = this.#supportedLanguage(storedLanguage)
		const configuration = {
			...this.#snapshot.configuration,
			siteAddress: resolveSiteAddress(this.#buildAddress, stored),
		}
		this.#client = new TenantApiClient(configuration, this.#transport)
		this.#update({
			configuration,
			languageOverride,
			language: this.#resolveLanguage(null, languageOverride),
		})
		if (!isBoundToTenant(configuration)) {
			this.#update({ phase: { kind: 'needsSite' } })
			return
		}
		await this.#loadSite()
	}

	/**
	 * Connects the app to the site the customer typed. Nothing is stored or
	 * switched until the site loads, so a typo cannot strand the app on an
	 * address that does not resolve.
	 */
	async connect(input: string): Promise<void> {
		if (this.#snapshot.isConnecting) return
		const address = parseSiteAddress(
			input,
			this.#snapshot.configuration.brandDomain,
			{ requireTls: this.#snapshot.configuration.useTls },
		)
		if (!address) {
			this.#update({ error: { reason: 'siteNotFound' } })
			return
		}
		await this.#loadSite(address)
	}

	async retry(): Promise<void> {
		if (!isBoundToTenant(this.#snapshot.configuration)) {
			this.#update({ phase: { kind: 'needsSite' } })
			return
		}
		await this.#loadSite()
	}

	/**
	 * Un-branded builds: back to "connect a site". The session is revoked
	 * (best effort) and deleted, and the site address and booking codes leave
	 * the device, so the next site starts from nothing. A site that did not
	 * load has no session to revoke; its stored tokens are only deleted.
	 */
	async leaveSite(): Promise<void> {
		if (isSiteBound(this.#buildAddress)) return
		this.#siteLoad += 1
		this.#contentLoad += 1
		const { session, features } = this.#snapshot
		this.#endCustomer(null)
		this.#unsubscribeSession?.()
		this.#unsubscribeSession = null
		this.#disposeFeatures(features)
		const configuration = {
			...this.#buildConfiguration,
			siteAddress: this.#buildAddress,
		}
		this.#client = new TenantApiClient(configuration, this.#transport)
		this.#update({
			phase: { kind: 'needsSite' },
			configuration,
			organization: null,
			theme: FALLBACK_SITE_THEME,
			language: this.#resolveLanguage(null, this.#snapshot.languageOverride),
			isConnecting: false,
			session: null,
			features: null,
			error: null,
		})
		await Promise.all([
			(session ? session.signOut() : this.#tokenStorage.save(null)).catch(
				() => undefined,
			),
			this.#preferences.saveSiteAddress(null).catch(() => undefined),
			this.#forgetSiteData?.().catch(() => undefined),
		])
	}

	dispose(): void {
		this.#disposed = true
		this.#siteLoad += 1
		this.#contentLoad += 1
		this.#authAttempt += 1
		this.#unsubscribeSession?.()
		this.#unsubscribeSession = null
		this.#disposeFeatures(this.#snapshot.features)
		this.#listeners.clear()
	}

	async #loadSite(binding?: SiteAddress): Promise<void> {
		const load = ++this.#siteLoad
		const configuration = binding
			? { ...this.#snapshot.configuration, siteAddress: binding }
			: this.#snapshot.configuration
		const client = new TenantApiClient(configuration, this.#transport)
		if (binding) this.#update({ isConnecting: true, error: null })
		else this.#update({ phase: { kind: 'loading' }, error: null })

		try {
			const organization = await client.fetchOrganization(
				this.#snapshot.languageOverride,
				this.#deviceLanguages(),
			)
			if (load !== this.#siteLoad) return
			const regional = {
				...configuration,
				dataRegion: resolvedDataRegion(organization),
			}
			// Customer data stays in its region: without that region's node this
			// build cannot sign anyone in, and no other node may stand in.
			if (!tenantApiBaseUrl(regional)) throw regionUnavailableError()
			if (binding) await this.#preferences.saveSiteAddress(binding)
			if (load !== this.#siteLoad) return
			await this.#configureSession(organization, regional, load)
		} catch (error) {
			if (load !== this.#siteLoad) return
			const failure = appErrorFrom(error, 'site')
			if (binding) this.#update({ isConnecting: false, error: failure })
			else this.#update({ phase: { kind: 'failed', error: failure } })
		}
	}

	/** One session per organization, on that organization's regional node. */
	async #configureSession(
		organization: PublicOrganization,
		configuration: TenantConfiguration,
		load: number,
	): Promise<void> {
		const client = new TenantApiClient(configuration, this.#transport)
		const session = new CustomerSession(client, this.#tokenStorage)
		let tokens = await session.restore()
		let foreign = false
		if (tokens && tokenOrgId(tokens) !== organization.id) {
			// A stored session belongs to one organization, maybe in another
			// region: forget it here and never send its tokens to this node.
			await session.discardLocal()
			tokens = null
			foreign = true
		}
		if (load !== this.#siteLoad) return

		this.#unsubscribeSession?.()
		this.#disposeFeatures(this.#snapshot.features)
		const features =
			this.#createFeatures?.({
				session,
				configuration,
				organization,
				language: () => this.#snapshot.language,
			}) ?? null
		// That customer's booking codes leave the device with their session.
		if (foreign) this.#resetFeatures(features)
		this.#client = client
		this.#unsubscribeSession = session.subscribe(() =>
			this.#sessionChanged(session),
		)
		this.#authAttempt += 1

		const signedIn = tokens !== null
		this.#update({
			phase: { kind: 'ready' },
			configuration,
			organization,
			theme: siteThemeFromPayload(organization.theme),
			language: this.#resolveLanguage(
				organization,
				this.#snapshot.languageOverride,
			),
			isConnecting: false,
			session,
			features,
			isSignedIn: signedIn,
			needsName: false,
			pendingPhone: null,
			isBusy: false,
			didResendCode: false,
			profile: null,
			profileStatus: 'idle',
			isSavingProfile: false,
			didSaveProfile: false,
			error: null,
		})
		if (signedIn) void this.loadProfile()
	}

	/** A refresh token that died (expired, revoked, replayed) ends the session. */
	#sessionChanged(session: CustomerSession): void {
		if (session !== this.#snapshot.session) return
		if (session.isSignedIn || !this.#snapshot.isSignedIn) return
		this.#endCustomer({ reason: 'signedOut' })
	}

	// MARK: - Language

	/** `null` follows the device again. */
	async setLanguageOverride(code: string | null): Promise<void> {
		const languageOverride = this.#supportedLanguage(code)
		if (languageOverride === this.#snapshot.languageOverride) return
		this.#update({
			languageOverride,
			language: this.#resolveLanguage(
				this.#snapshot.organization,
				languageOverride,
			),
		})
		await this.#preferences.saveLanguageOverride(languageOverride)
		void this.#reloadOrganizationContent()
	}

	/** Announcements and the site's name come back in the newly chosen language. */
	async #reloadOrganizationContent(): Promise<void> {
		const current = this.#snapshot.organization
		if (!current || this.#snapshot.phase.kind !== 'ready') return
		const load = ++this.#contentLoad
		const siteLoad = this.#siteLoad
		const region = this.#snapshot.configuration.dataRegion
		try {
			const next = await this.#client.fetchOrganization(
				this.#snapshot.languageOverride,
				this.#deviceLanguages(),
			)
			if (load !== this.#contentLoad || siteLoad !== this.#siteLoad) return
			// Only the content may change here; another organization or region
			// needs a new session, which only a full load sets up.
			if (next.id !== current.id || resolvedDataRegion(next) !== region) return
			this.#update({
				organization: next,
				theme: siteThemeFromPayload(next.theme),
				language: this.#resolveLanguage(next, this.#snapshot.languageOverride),
			})
		} catch {
			// The content already showing stays.
		}
	}

	#supportedLanguage(code: string | null | undefined): string | null {
		if (!code?.trim()) return null
		const normalized = normalizeLocale(code)
		return this.#appLocales.includes(normalized) ? normalized : null
	}

	#resolveLanguage(
		organization: PublicOrganization | null,
		override: string | null,
	): AppLanguage {
		return resolveAppLanguage({
			organization,
			deviceLanguages: this.#deviceLanguages(),
			appLocales: this.#appLocales,
			override,
		})
	}

	// MARK: - Sign-in

	async sendCode(phone: string): Promise<void> {
		const session = this.#snapshot.session
		if (!session || this.#snapshot.isBusy || this.#snapshot.isSignedIn) return
		if (!isValidPhone(phone)) {
			this.#update({ error: { reason: 'invalidPhone' }, didResendCode: false })
			return
		}
		const resending = this.#snapshot.pendingPhone !== null
		const attempt = this.#authAttempt
		this.#update({ isBusy: true, error: null, didResendCode: false })
		try {
			await session.sendCode(phone)
			if (attempt !== this.#authAttempt) return
			this.#update({
				isBusy: false,
				pendingPhone: normalizePhone(phone),
				didResendCode: resending,
			})
		} catch (error) {
			if (attempt !== this.#authAttempt) return
			this.#update({ isBusy: false, error: appErrorFrom(error, 'sendCode') })
		}
	}

	async resendCode(): Promise<void> {
		const phone = this.#snapshot.pendingPhone
		if (phone) await this.sendCode(phone)
	}

	async verify(code: string): Promise<void> {
		const session = this.#snapshot.session
		const phone = this.#snapshot.pendingPhone
		if (!session || !phone || this.#snapshot.isBusy) return
		const attempt = ++this.#authAttempt
		this.#update({ isBusy: true, error: null, didResendCode: false })
		try {
			const result = await session.verify(phone, code)
			if (attempt !== this.#authAttempt) return
			// A new sign-in is a new customer: nothing of an earlier session (an
			// expired one included) carries over.
			this.#resetFeatures(this.#snapshot.features)
			const needsName = result.needsName === true
			this.#update({
				isBusy: false,
				isSignedIn: true,
				needsName,
				pendingPhone: null,
				profile: null,
				profileStatus: 'idle',
			})
			if (!needsName) await this.loadProfile()
		} catch (error) {
			if (attempt !== this.#authAttempt) return
			this.#update({ isBusy: false, error: appErrorFrom(error, 'verify') })
		}
	}

	/**
	 * Abandons the attempt: a code check still in flight must not sign the
	 * customer in, and its error must not come back.
	 */
	cancelVerification(): void {
		this.#authAttempt += 1
		this.#snapshot.session?.abandonPendingVerification()
		this.#update({
			pendingPhone: null,
			error: null,
			isBusy: false,
			didResendCode: false,
		})
	}

	async completeName(name: string): Promise<void> {
		const session = this.#snapshot.session
		if (!session || !this.#snapshot.isSignedIn || this.#snapshot.isBusy) return
		if (characters(name.trim()) > NAME_MAX_LENGTH) {
			this.#update({ error: { reason: 'nameTooLong' } })
			return
		}
		const attempt = this.#authAttempt
		this.#update({ isBusy: true, error: null })
		try {
			const profile = await session.updateProfile(name, null)
			if (attempt !== this.#authAttempt) return
			this.#update({
				isBusy: false,
				needsName: false,
				profile,
				profileStatus: 'loaded',
			})
		} catch (error) {
			if (attempt !== this.#authAttempt) return
			this.#update({ isBusy: false })
			this.#fail(error, 'name')
		}
	}

	/** Ends the session on the device at once; revoking it on the server is best effort. */
	async signOut(): Promise<void> {
		const session = this.#snapshot.session
		this.#endCustomer(null)
		await session?.signOut()
	}

	// MARK: - Profile

	async loadProfile(): Promise<void> {
		const session = this.#snapshot.session
		if (!session || !this.#snapshot.isSignedIn) return
		const attempt = this.#authAttempt
		this.#update({ profileStatus: 'loading' })
		try {
			const profile = await session.profile()
			if (attempt !== this.#authAttempt) return
			this.#update({
				profile,
				profileStatus: 'loaded',
				needsName: this.#snapshot.needsName || profile.needsName === true,
			})
		} catch (error) {
			if (attempt !== this.#authAttempt) return
			this.#update({ profileStatus: 'failed' })
			this.#fail(error, 'profile')
		}
	}

	/** An empty email clears the stored one. */
	async saveProfile(name: string, email: string): Promise<void> {
		const session = this.#snapshot.session
		if (
			!session ||
			!this.#snapshot.isSignedIn ||
			this.#snapshot.isSavingProfile
		)
			return
		const trimmedEmail = email.trim()
		if (characters(name.trim()) > NAME_MAX_LENGTH) {
			this.#update({ error: { reason: 'nameTooLong' }, didSaveProfile: false })
			return
		}
		if (
			trimmedEmail &&
			(trimmedEmail.length > EMAIL_MAX_LENGTH || !EMAIL.test(trimmedEmail))
		) {
			this.#update({ error: { reason: 'invalidEmail' }, didSaveProfile: false })
			return
		}
		const attempt = this.#authAttempt
		this.#update({ isSavingProfile: true, error: null, didSaveProfile: false })
		try {
			const profile = await session.updateProfile(name, trimmedEmail)
			if (attempt !== this.#authAttempt) return
			this.#update({
				isSavingProfile: false,
				didSaveProfile: true,
				profile,
				profileStatus: 'loaded',
			})
		} catch (error) {
			if (attempt !== this.#authAttempt) return
			this.#update({ isSavingProfile: false })
			this.#fail(error, 'profile')
		}
	}

	clearTransientMessages(): void {
		const { error, didSaveProfile, didResendCode } = this.#snapshot
		if (!error && !didSaveProfile && !didResendCode) return
		this.#update({ error: null, didSaveProfile: false, didResendCode: false })
	}

	// MARK: - Helpers

	/**
	 * A 401 that survived the refresh means the server no longer knows this
	 * session; a 403 organization_inactive means the organization is gone.
	 */
	#fail(error: unknown, action: AppAction): void {
		if (error instanceof ApiError && error.endsSession) {
			const session = this.#snapshot.session
			this.#endCustomer({ reason: 'signedOut' })
			void session?.signOut()
			return
		}
		this.#update({ error: appErrorFrom(error, action) })
	}

	#endCustomer(error: AppError | null): void {
		this.#authAttempt += 1
		this.#resetFeatures(this.#snapshot.features)
		this.#update({
			isSignedIn: false,
			needsName: false,
			pendingPhone: null,
			isBusy: false,
			didResendCode: false,
			profile: null,
			profileStatus: 'idle',
			isSavingProfile: false,
			didSaveProfile: false,
			error,
		})
	}

	#resetFeatures(features: Features | null): void {
		if (!features) return
		for (const feature of Object.values(features)) feature.reset()
	}

	#disposeFeatures(features: Features | null): void {
		if (!features) return
		for (const feature of Object.values(features)) feature.dispose?.()
	}

	#update(patch: Partial<AppSnapshot<Features>>): void {
		if (this.#disposed) return
		this.#snapshot = { ...this.#snapshot, ...patch }
		for (const listener of this.#listeners) listener()
	}
}
