import {
	type TenantConfiguration,
	tenantApiBaseUrl,
} from '../config/configuration'
import { type AuthTokens } from '../session/auth-tokens'
import { authOriginHeader, siteQuery } from '../support/site-address'
import {
	ApiError,
	notBoundToTenantError,
	regionUnavailableError,
} from './api-error'
import { fetchTransport, type HttpTransport } from './http'
import {
	customerProfileEnvelopeSchema,
	type CustomerProfile,
	type PublicOrganization,
	publicOrganizationSchema,
	type VerifyResult,
	verifyResultSchema,
} from './public-site'
import {
	buildUrl,
	decodeResponse,
	performRequest,
	type QueryItems,
	type RequestSpec,
} from './request'

const LANGUAGE_TAG = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/
const MAX_ACCEPT_LANGUAGES = 6

/**
 * The two public APIs the app depends on:
 *
 * - the US control-plane App (`/resources/sites`) for the published branding,
 *   which holds no customer data;
 * - the organization's regional tenant-api (`/auth/*`) for phone sign-in and
 *   the profile. Customer data lives only there, and the app calls it directly.
 */
export class TenantApiClient {
	readonly configuration: TenantConfiguration
	readonly #transport: HttpTransport

	constructor(
		configuration: TenantConfiguration,
		transport: HttpTransport = fetchTransport,
	) {
		this.configuration = configuration
		this.#transport = transport
	}

	get transport(): HttpTransport {
		return this.#transport
	}

	/** The organization's regional tenant-api node. */
	regionalBaseUrl(): string {
		const base = tenantApiBaseUrl(this.configuration)
		if (!base) throw regionUnavailableError()
		return base
	}

	/**
	 * `locale` is the customer's own choice; `acceptLanguage` the device
	 * languages, which the App negotiates against the site's locales.
	 */
	async fetchOrganization(
		locale?: string | null,
		acceptLanguage: readonly string[] = [],
	): Promise<PublicOrganization> {
		const binding = siteQuery(this.configuration.siteAddress)
		if (!binding) throw notBoundToTenantError()
		const query: QueryItems = [[binding.name, binding.value]]
		if (locale) query.push(['lng', locale])
		const path = '/resources/sites'
		const headers: Record<string, string> = { Accept: 'application/json' }
		const languages = acceptLanguage
			.map((tag) => tag.trim())
			.filter((tag) => LANGUAGE_TAG.test(tag))
			.slice(0, MAX_ACCEPT_LANGUAGES)
		if (languages.length > 0) headers['Accept-Language'] = languages.join(', ')
		const response = await this.#perform({
			method: 'GET',
			url: buildUrl(this.configuration.appBaseUrl, path, query),
			headers,
		})
		return decodeResponse(response, publicOrganizationSchema, path)
	}

	async sendCode(phone: string): Promise<void> {
		await this.#perform(this.#boundPost('/auth/send-code', { phone }))
	}

	async verify(phone: string, code: string): Promise<VerifyResult> {
		const path = '/auth/verify'
		const response = await this.#perform(this.#boundPost(path, { phone, code }))
		const result = decodeResponse(response, verifyResultSchema, path)
		if (!result.accessToken || !result.refreshToken) {
			throw new ApiError(
				400,
				result.error || 'Verification failed',
				'verification_failed',
			)
		}
		return result
	}

	async refresh(refreshToken: string, orgId: string): Promise<AuthTokens> {
		const path = '/auth/refresh'
		const response = await this.#perform({
			method: 'POST',
			url: buildUrl(this.regionalBaseUrl(), path),
			headers: { Accept: 'application/json' },
			json: { refreshToken, orgId },
		})
		const payload = decodeResponse(response, verifyResultSchema, path)
		if (!payload.accessToken || !payload.refreshToken) {
			throw new ApiError(
				401,
				'Session expired. Please sign in again.',
				'session_expired',
			)
		}
		return {
			accessToken: payload.accessToken,
			refreshToken: payload.refreshToken,
		}
	}

	/** Best effort: the local session ends whatever the server answers. */
	async logout(refreshToken: string, orgId: string | null): Promise<void> {
		if (!orgId) return
		try {
			await this.#perform({
				method: 'POST',
				url: buildUrl(this.regionalBaseUrl(), '/auth/logout'),
				json: { refreshToken, orgId },
			})
		} catch {
			// Ignored: an unreachable server must not keep the customer signed in.
		}
	}

	async fetchProfile(accessToken: string): Promise<CustomerProfile> {
		const path = '/auth/me'
		const response = await this.#perform({
			method: 'GET',
			url: buildUrl(this.regionalBaseUrl(), path),
			headers: {
				Accept: 'application/json',
				Authorization: `Bearer ${accessToken}`,
			},
		})
		const envelope = decodeResponse(
			response,
			customerProfileEnvelopeSchema,
			path,
		)
		if (!envelope.customer)
			throw new ApiError(404, 'Customer not found', 'not_found')
		return envelope.customer
	}

	/** `email` undefined leaves the stored email alone; an empty string clears it. */
	async updateProfile(
		name: string,
		email: string | undefined,
		accessToken: string,
	): Promise<AuthTokens> {
		const path = '/auth/profile'
		const response = await this.#perform({
			method: 'POST',
			url: buildUrl(this.regionalBaseUrl(), path),
			headers: {
				Accept: 'application/json',
				Authorization: `Bearer ${accessToken}`,
			},
			json: email === undefined ? { name } : { name, email },
		})
		const payload = decodeResponse(response, verifyResultSchema, path)
		if (!payload.accessToken || !payload.refreshToken) {
			throw new ApiError(
				400,
				payload.error || 'Could not save your profile',
				'profile_not_saved',
			)
		}
		return {
			accessToken: payload.accessToken,
			refreshToken: payload.refreshToken,
		}
	}

	/**
	 * tenant-api binds send-code and verify to the organization the caller
	 * claims to be: slug or host in the body, plus the site's https origin as
	 * `Origin` (the rule Sites satisfies with its Host header).
	 */
	#boundPost(
		path: string,
		fields: Record<string, string>,
	): Omit<RequestSpec, 'timeoutMs'> {
		const binding = siteQuery(this.configuration.siteAddress)
		const headers: Record<string, string> = { Accept: 'application/json' }
		const origin = authOriginHeader(this.configuration.siteAddress)
		if (origin) headers.Origin = origin
		return {
			method: 'POST',
			url: buildUrl(this.regionalBaseUrl(), path),
			headers,
			json: binding ? { ...fields, [binding.name]: binding.value } : fields,
		}
	}

	#perform(spec: Omit<RequestSpec, 'timeoutMs'>) {
		return performRequest(this.#transport, {
			...spec,
			timeoutMs: this.configuration.requestTimeoutMs,
		})
	}
}
