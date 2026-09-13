import { type ProviderUser } from '@repo/auth'
import {
	and,
	db,
	eq,
	isNull,
	Organization,
	OrganizationRole,
	SSOConfiguration as SSOConfigurationTable,
	SSOSession as SSOSessionTable,
	User as UserTable,
	UserOrganization,
	Role,
	_RoleToUser,
} from '@repo/database'
import {
	type User,
	type SSOConfiguration,
	type SSOSession,
} from '@repo/database/types'
import { encrypt, decrypt, getSSOMasterKey } from '@repo/security'
import {
	ssoCache,
	ssoConnectionPool,
	resolveEndpoints as resolveOIDCEndpoints,
	type EndpointConfiguration,
	validateIDToken,
	type IDTokenClaims,
	IDTokenValidationErrorCode,
	ssoRetryManager,
} from '@repo/sso'
import { OAuth2Strategy, CodeChallengeMethod } from 'remix-auth-oauth2'
import { ssoConfigurationService } from './configuration.server.ts'

export interface OIDCUserInfo {
	sub: string
	email?: string
	email_verified?: boolean
	name?: string
	preferred_username?: string
	given_name?: string
	family_name?: string
	picture?: string
	groups?: string[]
	[key: string]: any
}

export interface TokenSet {
	accessToken: string
	refreshToken?: string
	idToken?: string
	expiresAt: Date
	scope: string[]
}

/**
 * Service for managing SSO authentication flows
 */
export class SSOAuthService {
	// Remove in-memory strategies map - now using cache
	// private strategies = new Map<string, OAuth2Strategy<ProviderUser>>()

	/**
	 * Create an OAuth2 strategy for the given SSO configuration
	 */
	async createStrategy(
		config: SSOConfiguration,
	): Promise<OAuth2Strategy<ProviderUser>> {
		const endpoints = await this.resolveEndpoints(config)
		const clientSecret =
			await ssoConfigurationService.getDecryptedClientSecret(config)

		const strategyOptions = {
			clientId: config.clientId,
			clientSecret,
			authorizationEndpoint: endpoints.authorizationUrl,
			tokenEndpoint: endpoints.tokenUrl,
			redirectURI: await this.buildRedirectURI(config.organizationId),
			scopes: config.scopes.split(' '),
			codeChallengeMethod: config.pkceEnabled
				? CodeChallengeMethod.S256
				: undefined,
		}

		// Security: Never log strategy options as they contain sensitive client secrets
		return new OAuth2Strategy(strategyOptions, async ({ tokens, request }) => {
			return this.handleUserInfo(tokens, config, request)
		})
	}

	/**
	 * Get or create a cached strategy for an organization
	 */
	async getStrategy(
		organizationId: string,
	): Promise<OAuth2Strategy<ProviderUser> | null> {
		// Check cache first
		const cachedStrategy = ssoCache.getStrategy(organizationId)
		if (cachedStrategy) {
			return cachedStrategy
		}

		// Load configuration from cache or database
		let config = ssoCache.getConfiguration(organizationId)
		if (!config) {
			config = await ssoConfigurationService.getConfiguration(organizationId)
			if (config) {
				ssoCache.setConfiguration(organizationId, config)
			}
		}

		if (!config || !config.isEnabled) {
			return null
		}

		// Create and cache strategy
		const strategy = await this.createStrategy(config)
		ssoCache.setStrategy(organizationId, strategy)

		return strategy
	}

	/**
	 * Refresh a cached strategy (call when configuration changes)
	 */
	async refreshStrategy(organizationId: string): Promise<void> {
		ssoCache.invalidateConfiguration(organizationId)
		await this.getStrategy(organizationId) // This will recreate it
	}

	/**
	 * Initiate SSO authentication flow
	 */
	async initiateAuth(
		organizationId: string,
		request: Request,
		nonce?: string,
	): Promise<Response> {
		const strategy = await this.getStrategy(organizationId)
		if (!strategy) {
			throw new Error('SSO not configured or enabled for this organization')
		}

		// Create a modified request URL with nonce parameter for OIDC
		// The nonce will be included in the authorization request
		let authRequest = request
		if (nonce) {
			const url = new URL(request.url)
			url.searchParams.set('nonce', nonce)
			authRequest = new Request(url.toString(), request)
		}

		// Use the strategy's authenticate method which returns a Response for redirects
		try {
			await strategy.authenticate(authRequest)
			// If we get here, it means authentication failed or there's an issue
			throw new Error('Unexpected authentication result')
		} catch (error) {
			if (error instanceof Response) {
				return error
			}
			throw error
		}
	}

	/**
	 * Handle OAuth callback and return authenticated user
	 */
	async handleCallback(
		organizationId: string,
		request: Request,
		nonce?: string,
	): Promise<ProviderUser> {
		const strategy = await this.getStrategy(organizationId)
		if (!strategy) {
			throw new Error('SSO not configured or enabled for this organization')
		}

		// Attach nonce to request for ID token validation in handleUserInfo
		if (nonce) {
			;(request as any).ssoNonce = nonce
		}

		// Use the strategy's authenticate method which returns user info on callback
		const result = await strategy.authenticate(request)

		// If it's a Response (redirect), throw it to be handled by the framework
		if (result instanceof Response) {
			throw result
		}

		return result as ProviderUser
	}

	/**
	 * Provision or update user from SSO authentication
	 */
	async provisionUser(
		userInfo: OIDCUserInfo,
		config: SSOConfiguration,
	): Promise<User> {
		const attributeMapping = ssoConfigurationService.getAttributeMapping(config)

		// Extract user attributes using mapping
		const email = this.extractAttribute(userInfo, attributeMapping.email!)
		const name = this.extractAttribute(userInfo, attributeMapping.name!)
		const baseUsername =
			this.extractAttribute(userInfo, attributeMapping.username!) ||
			email?.split('@')[0] ||
			userInfo.sub

		if (!email) {
			throw new Error(
				'Email is required for user provisioning. Ensure the "email" scope is requested and the email attribute is mapped correctly.',
			)
		}

		if (!baseUsername) {
			throw new Error('Username is required for user provisioning')
		}

		// Validate email policies
		this.validateEmailPolicies(email, userInfo, config)

		// Check if user already exists
		const [existingUser] = await db
			.select()
			.from(UserTable)
			.where(eq(UserTable.email, email.toLowerCase()))
			.limit(1)

		if (existingUser) {
			// For existing users, check if they are already a member of the organization
			const [existingMembership] = await db
				.select({ userId: UserOrganization.userId })
				.from(UserOrganization)
				.where(
					and(
						eq(UserOrganization.userId, existingUser.id),
						eq(UserOrganization.organizationId, config.organizationId),
					),
				)
				.limit(1)

			// If user exists but is not a member, only add them if autoProvision is enabled
			if (!existingMembership && !config.autoProvision) {
				throw new Error(
					'User exists but is not a member of this organization. Auto-provisioning is disabled.',
				)
			}

			// Update existing user with SSO attributes
			return this.updateUserFromSSO(existingUser.id, userInfo, config)
		}

		if (!config.autoProvision) {
			throw new Error('User does not exist and auto-provisioning is disabled')
		}

		// Generate a unique username to avoid collisions
		const username = await this.generateUniqueUsername(
			baseUsername.toLowerCase(),
		)

		// Create new user
		const [user] = await db
			.insert(UserTable)
			.values({
				email: email.toLowerCase(),
				username,
				name: name || email,
			})
			.returning()
		if (!user) throw new Error('Failed to provision user')
		const [userRole] = await db
			.select({ id: Role.id })
			.from(Role)
			.where(eq(Role.name, 'user'))
			.limit(1)
		if (userRole)
			await db.insert(_RoleToUser).values({ A: userRole.id, B: user.id })

		// Add user to organization
		await this.ensureOrganizationMembership(
			user.id,
			config.organizationId,
			config.defaultRole,
		)

		return user
	}

	/**
	 * Generate a unique username, appending a suffix if needed
	 */
	private async generateUniqueUsername(baseUsername: string): Promise<string> {
		let username = baseUsername
		let suffix = 0
		const maxAttempts = 100

		while (suffix < maxAttempts) {
			const [existingUser] = await db
				.select({ id: UserTable.id })
				.from(UserTable)
				.where(eq(UserTable.username, username))
				.limit(1)

			if (!existingUser) {
				return username
			}

			suffix++
			username = `${baseUsername}-${suffix}`
		}

		// Fallback: use timestamp-based suffix
		return `${baseUsername}-${Date.now()}`
	}

	/**
	 * Validate email policies (verified email requirement, domain allowlist)
	 */
	private validateEmailPolicies(
		email: string,
		userInfo: OIDCUserInfo,
		config: SSOConfiguration,
	): void {
		// Check if verified email is required
		const requireVerifiedEmail = (config as any).requireVerifiedEmail ?? false
		if (requireVerifiedEmail && userInfo.email_verified !== true) {
			throw new Error(
				'Email verification is required. The identity provider did not confirm this email as verified.',
			)
		}

		// Check allowed email domains
		const allowedEmailDomains = (config as any).allowedEmailDomains as
			string | null
		if (allowedEmailDomains) {
			const emailDomain = email.split('@')[1]?.toLowerCase()
			if (!emailDomain) {
				throw new Error('Invalid email format: missing domain')
			}

			const allowedDomains = allowedEmailDomains
				.split(',')
				.map((d) => d.trim().toLowerCase())
				.filter(Boolean)

			if (allowedDomains.length > 0 && !allowedDomains.includes(emailDomain)) {
				throw new Error(
					`Email domain "${emailDomain}" is not allowed for this organization. Allowed domains: ${allowedDomains.join(', ')}`,
				)
			}
		}
	}

	/**
	 * Update existing user with SSO attributes
	 */
	async updateUserFromSSO(
		userId: string,
		userInfo: OIDCUserInfo,
		config: SSOConfiguration,
	): Promise<User> {
		const attributeMapping = ssoConfigurationService.getAttributeMapping(config)

		const name = this.extractAttribute(userInfo, attributeMapping.name!)

		const [user] = await db
			.update(UserTable)
			.set(name ? { name } : {})
			.where(eq(UserTable.id, userId))
			.returning()
		if (!user) throw new Error('User not found')

		// Ensure user is member of the organization
		await this.ensureOrganizationMembership(
			userId,
			config.organizationId,
			config.defaultRole,
		)

		return user
	}

	/**
	 * Create SSO session with encrypted tokens
	 */
	async createSSOSession(
		sessionId: string,
		ssoConfigId: string,
		providerUserId: string,
		tokens: TokenSet,
	): Promise<SSOSession> {
		const masterKey = getSSOMasterKey()

		const [session] = await db
			.insert(SSOSessionTable)
			.values({
				sessionId,
				ssoConfigId,
				providerUserId,
				accessToken: tokens.accessToken
					? encrypt(tokens.accessToken, masterKey)
					: null,
				refreshToken: tokens.refreshToken
					? encrypt(tokens.refreshToken, masterKey)
					: null,
				tokenExpiresAt: tokens.expiresAt,
			})
			.returning()
		if (!session) throw new Error('Failed to create SSO session')
		return session
	}

	/**
	 * Refresh access tokens using refresh token
	 */
	async refreshTokens(ssoSessionId: string): Promise<TokenSet> {
		const [sessionRow] = await db
			.select({ session: SSOSessionTable, ssoConfig: SSOConfigurationTable })
			.from(SSOSessionTable)
			.innerJoin(
				SSOConfigurationTable,
				eq(SSOSessionTable.ssoConfigId, SSOConfigurationTable.id),
			)
			.where(eq(SSOSessionTable.id, ssoSessionId))
			.limit(1)
		const ssoSession = sessionRow
			? { ...sessionRow.session, ssoConfig: sessionRow.ssoConfig }
			: null

		if (!ssoSession || !ssoSession.refreshToken) {
			throw new Error('SSO session not found or no refresh token available')
		}

		const masterKey = getSSOMasterKey()
		const refreshToken = decrypt(ssoSession.refreshToken!, masterKey)
		const endpoints = await this.resolveEndpoints(ssoSession.ssoConfig)
		const clientSecret = await ssoConfigurationService.getDecryptedClientSecret(
			ssoSession.ssoConfig,
		)

		// Make token refresh request with retry logic
		const tokenResult = await ssoRetryManager.retryTokenExchange(async () => {
			const response = await ssoConnectionPool.request(endpoints.tokenUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					Accept: 'application/json',
				},
				body: new URLSearchParams({
					grant_type: 'refresh_token',
					refresh_token: refreshToken,
					client_id: ssoSession.ssoConfig.clientId,
					client_secret: clientSecret,
				}),
			})

			if (!response.ok) {
				throw new Error(
					`Token refresh failed: ${response.status} ${response.statusText}`,
				)
			}

			return response.json()
		}, ssoSession.ssoConfig.providerName)

		if (!tokenResult.success) {
			throw new Error(
				`Token refresh failed: ${tokenResult.error?.message || 'Unknown error'}`,
			)
		}

		const tokenData: any = tokenResult.result

		const newTokenSet: TokenSet = {
			accessToken: tokenData.access_token,
			refreshToken: tokenData.refresh_token || refreshToken, // Keep old refresh token if new one not provided
			idToken: tokenData.id_token,
			expiresAt: new Date(Date.now() + tokenData.expires_in * 1000),
			scope: tokenData.scope ? tokenData.scope.split(' ') : [],
		}

		// Update stored tokens
		await db
			.update(SSOSessionTable)
			.set({
				accessToken: encrypt(newTokenSet.accessToken, masterKey),
				refreshToken: newTokenSet.refreshToken
					? encrypt(newTokenSet.refreshToken, masterKey)
					: null,
				tokenExpiresAt: newTokenSet.expiresAt,
			})
			.where(eq(SSOSessionTable.id, ssoSessionId))

		return newTokenSet
	}

	/**
	 * Revoke tokens at the identity provider
	 */
	async revokeTokens(ssoSessionId: string): Promise<void> {
		const [sessionRow] = await db
			.select({ session: SSOSessionTable, ssoConfig: SSOConfigurationTable })
			.from(SSOSessionTable)
			.innerJoin(
				SSOConfigurationTable,
				eq(SSOSessionTable.ssoConfigId, SSOConfigurationTable.id),
			)
			.where(eq(SSOSessionTable.id, ssoSessionId))
			.limit(1)
		const ssoSession = sessionRow
			? { ...sessionRow.session, ssoConfig: sessionRow.ssoConfig }
			: null

		if (!ssoSession) {
			return // Session doesn't exist, nothing to revoke
		}

		const endpoints = await this.resolveEndpoints(ssoSession.ssoConfig)

		if (!endpoints.revocationUrl) {
			// Identity provider doesn't support token revocation
			return
		}

		const masterKey = getSSOMasterKey()
		const clientSecret = await ssoConfigurationService.getDecryptedClientSecret(
			ssoSession.ssoConfig,
		)

		// Revoke access token if available
		if (ssoSession.accessToken && endpoints.revocationUrl) {
			const accessToken = decrypt(ssoSession.accessToken!, masterKey)
			await this.revokeToken(
				endpoints.revocationUrl,
				accessToken,
				ssoSession.ssoConfig.clientId,
				clientSecret,
			)
		}

		// Revoke refresh token if available
		if (ssoSession.refreshToken && endpoints.revocationUrl) {
			const refreshToken = decrypt(ssoSession.refreshToken!, masterKey)
			await this.revokeToken(
				endpoints.revocationUrl,
				refreshToken,
				ssoSession.ssoConfig.clientId,
				clientSecret,
			)
		}

		// Delete the SSO session
		await db.delete(SSOSessionTable).where(eq(SSOSessionTable.id, ssoSessionId))
	}

	/**
	 * Handle user info from OAuth callback
	 */
	private async handleUserInfo(
		tokens: any,
		config: SSOConfiguration,
		request: Request,
	): Promise<ProviderUser & { tokens?: TokenSet }> {
		const endpoints = await this.resolveEndpoints(config)
		const nonce = (request as any).ssoNonce as string | undefined

		// Validate ID token if present (OIDC compliance)
		let idTokenClaims: IDTokenClaims | undefined
		if (tokens.idToken && endpoints.jwksUrl) {
			const validationResult = await this.validateIDTokenSafe(
				tokens.idToken,
				endpoints.jwksUrl,
				config,
				nonce,
			)

			if (!validationResult.valid) {
				// Log the error but don't necessarily fail - some providers may have issues
				console.warn(
					`ID token validation warning for ${config.providerName}: ${validationResult.error}`,
				)

				// For critical errors, fail the authentication
				if (
					validationResult.errorCode ===
						IDTokenValidationErrorCode.INVALID_SIGNATURE ||
					validationResult.errorCode ===
						IDTokenValidationErrorCode.INVALID_ISSUER ||
					validationResult.errorCode ===
						IDTokenValidationErrorCode.INVALID_AUDIENCE
				) {
					throw new Error(
						`ID token validation failed: ${validationResult.error}. This may indicate a security issue.`,
					)
				}
			} else {
				idTokenClaims = validationResult.claims
			}
		}

		// Get user info from the identity provider (or use ID token claims)
		let userInfo: OIDCUserInfo

		if (idTokenClaims && idTokenClaims.email) {
			// If ID token has email, we can use it directly (more secure)
			userInfo = this.convertIDTokenClaimsToUserInfo(idTokenClaims)

			// Optionally supplement with userinfo endpoint for additional claims
			if (endpoints.userinfoUrl) {
				try {
					const additionalInfo = await this.fetchUserInfo(
						tokens.accessToken,
						config,
					)
					// Merge, but prefer ID token claims for security-critical fields
					userInfo = {
						...additionalInfo,
						...userInfo, // ID token claims take precedence
					}
				} catch (error) {
					// UserInfo fetch failed, but we have ID token claims - continue
					console.warn(
						'UserInfo fetch failed, using ID token claims only:',
						error,
					)
				}
			}
		} else {
			// Fall back to userinfo endpoint
			userInfo = await this.fetchUserInfo(tokens.accessToken, config)
		}

		// Provision or update user
		const user = await this.provisionUser(userInfo, config)

		// Prepare token set for session management
		const tokenSet: TokenSet = {
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken,
			idToken: tokens.idToken,
			expiresAt: tokens.expiresIn
				? new Date(Date.now() + tokens.expiresIn * 1000)
				: new Date(Date.now() + 3600000), // Default 1 hour
			scope: tokens.scope ? tokens.scope.split(' ') : config.scopes.split(' '),
		}

		return {
			id: user.id,
			email: user.email,
			username: user.username,
			name: user.name ?? undefined,
			tokens: tokenSet,
		}
	}

	/**
	 * Validate ID token with error handling
	 */
	private async validateIDTokenSafe(
		idToken: string,
		jwksUrl: string,
		config: SSOConfiguration,
		nonce?: string,
	): Promise<{
		valid: boolean
		claims?: IDTokenClaims
		error?: string
		errorCode?: IDTokenValidationErrorCode
	}> {
		try {
			return await validateIDToken(idToken, jwksUrl, {
				issuer: config.issuerUrl,
				clientId: config.clientId,
				nonce: nonce, // Use passed nonce for validation
				clockTolerance: 120, // 2 minutes tolerance for clock skew
			})
		} catch (error) {
			return {
				valid: false,
				error: `ID token validation error: ${error instanceof Error ? error.message : 'Unknown error'}`,
				errorCode: IDTokenValidationErrorCode.INVALID_TOKEN,
			}
		}
	}

	/**
	 * Convert ID token claims to OIDCUserInfo format
	 */
	private convertIDTokenClaimsToUserInfo(claims: IDTokenClaims): OIDCUserInfo {
		return {
			sub: claims.sub,
			email: claims.email,
			email_verified: claims.email_verified,
			name: claims.name,
			preferred_username: claims.preferred_username,
			given_name: claims.given_name,
			family_name: claims.family_name,
			picture: claims.picture,
		}
	}

	/**
	 * Fetch user info from identity provider
	 */
	private async fetchUserInfo(
		accessToken: string,
		config: SSOConfiguration,
	): Promise<OIDCUserInfo> {
		const endpoints = await this.resolveEndpoints(config)

		if (!endpoints.userinfoUrl) {
			throw new Error('UserInfo endpoint not available')
		}

		const userInfoResult = await ssoRetryManager.retryUserInfoFetch(
			async () => {
				const response = await ssoConnectionPool.request(
					endpoints.userinfoUrl!,
					{
						headers: {
							Authorization: `Bearer ${accessToken}`,
							Accept: 'application/json',
						},
					},
				)

				if (!response.ok) {
					throw new Error(
						`Failed to fetch user info: ${response.status} ${response.statusText}`,
					)
				}

				return response.json()
			},
			config.providerName,
		)

		if (!userInfoResult.success) {
			throw new Error(
				`User info fetch failed: ${userInfoResult.error?.message || 'Unknown error'}`,
			)
		}

		return userInfoResult.result as OIDCUserInfo
	}

	private async resolveEndpoints(
		config: SSOConfiguration,
	): Promise<EndpointConfiguration> {
		const manualEndpoints = config.autoDiscovery
			? undefined
			: {
					authorizationUrl: config.authorizationUrl ?? undefined,
					tokenUrl: config.tokenUrl ?? undefined,
					userinfoUrl: config.userinfoUrl ?? undefined,
					revocationUrl: config.revocationUrl ?? undefined,
				}

		const discoveryResult = await ssoRetryManager.retryOIDCDiscovery(
			() =>
				resolveOIDCEndpoints(
					config.issuerUrl,
					manualEndpoints,
					config.autoDiscovery,
				),
			config.issuerUrl,
		)

		if (!discoveryResult.success || !discoveryResult.result?.endpoints) {
			throw new Error(
				`OIDC discovery failed: ${discoveryResult.result?.error || discoveryResult.error?.message || 'Unknown error'}`,
			)
		}

		return discoveryResult.result.endpoints
	}

	/**
	 * Build redirect URI for OAuth callback
	 */
	private async buildRedirectURI(organizationId: string): Promise<string> {
		// Get organization slug for the redirect URI
		const [organization] = await db
			.select({ slug: Organization.slug })
			.from(Organization)
			.where(eq(Organization.id, organizationId))
			.limit(1)

		if (!organization) {
			throw new Error(`Organization not found: ${organizationId}`)
		}

		const baseUrl = process.env.BASE_URL
		if (!baseUrl) {
			throw new Error('BASE_URL environment variable is required')
		}
		return `${baseUrl}/auth/sso/${organization.slug}/callback`
	}

	/**
	 * Extract attribute value using mapping
	 */
	private extractAttribute(
		userInfo: OIDCUserInfo,
		attributePath: string,
	): string | undefined {
		if (!attributePath) return undefined

		// Support dot notation for nested attributes
		const parts = attributePath.split('.')
		let value: any = userInfo

		for (const part of parts) {
			if (value && typeof value === 'object') {
				value = value[part]
			} else {
				return undefined
			}
		}

		return typeof value === 'string' ? value : undefined
	}

	/**
	 * Ensure user is a member of the organization
	 * Uses upsert to prevent race conditions under concurrent logins
	 */
	private async ensureOrganizationMembership(
		userId: string,
		organizationId: string,
		defaultRole: string,
	): Promise<void> {
		// Find the organization role by name first
		const [organizationRole] = await db
			.select()
			.from(OrganizationRole)
			.where(
				and(
					eq(OrganizationRole.name, defaultRole),
					isNull(OrganizationRole.organizationId),
				),
			)
			.limit(1)

		if (!organizationRole) {
			throw new Error(`Organization role '${defaultRole}' not found`)
		}

		// Use upsert to handle race conditions - if membership exists, do nothing
		await db
			.insert(UserOrganization)
			.values({
				userId,
				organizationId,
				organizationRoleId: organizationRole.id,
			})
			.onConflictDoNothing()
	}

	/**
	 * Revoke a single token at the identity provider
	 */
	private async revokeToken(
		revocationUrl: string,
		token: string,
		clientId: string,
		clientSecret: string,
	): Promise<void> {
		try {
			await ssoConnectionPool.request(revocationUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					Accept: 'application/json',
				},
				body: new URLSearchParams({
					token,
					client_id: clientId,
					client_secret: clientSecret,
				}),
			})
		} catch (error) {
			// Token revocation is best-effort, don't throw on failure
			console.warn('Token revocation failed:', error)
		}
	}
}

// Export singleton instance
export const ssoAuthService = new SSOAuthService()
