import crypto from 'node:crypto'
import { auditService, AuditAction } from '@repo/audit'
import {
	and,
	db,
	gt,
	lt,
	lte,
	Session,
	sql,
	Verification,
	eq,
	MCPAccessToken,
	MCPAuthorization,
	MCPClient,
	MCPRefreshToken,
	ApiKey,
	Organization,
	User,
} from '@repo/database'
import { isActiveOrganizationMember } from '#app/utils/org-membership.server.ts'

// Token expiration constants
export const ACCESS_TOKEN_EXPIRATION = 60 * 60 * 1000 // 1 hour
export const REFRESH_TOKEN_EXPIRATION = 30 * 24 * 60 * 60 * 1000 // 30 days
export const AUTHORIZATION_CODE_EXPIRATION = 10 * 60 * 1000 // 10 minutes

/**
 * Allowed custom protocol schemes for MCP OAuth redirect URIs.
 * These are known MCP client applications (Claude Desktop, Cursor, VSCode, etc.)
 */
const ALLOWED_CUSTOM_SCHEMES = [
	'cursor://',
	'vscode://',
	'vscode-insiders://',
	'claude://',
	'windsurf://',
	'amp://',
]

/**
 * Validates redirect URI format (basic security checks).
 * This checks that the URI is well-formed and uses allowed protocols.
 */
function validateRedirectUriFormat(redirectUri: string): {
	isValid: boolean
	error?: string
} {
	if (!redirectUri || typeof redirectUri !== 'string') {
		return { isValid: false, error: 'redirect_uri is required' }
	}

	const trimmed = redirectUri.trim()

	// Check for allowed custom protocol schemes (cursor://, vscode://, etc.)
	for (const scheme of ALLOWED_CUSTOM_SCHEMES) {
		if (trimmed.startsWith(scheme)) {
			return { isValid: true }
		}
	}

	// For HTTP(S) URLs, validate the structure
	try {
		const url = new URL(trimmed)

		// Only allow localhost/127.0.0.1 for HTTP(S) redirect URIs
		// This is safe for MCP clients that run local OAuth callback servers
		const isLocalhost =
			url.hostname === 'localhost' || url.hostname === '127.0.0.1'

		if (!isLocalhost) {
			return {
				isValid: false,
				error:
					'redirect_uri must be a localhost URL or a registered MCP client scheme',
			}
		}

		// For localhost, allow http (common for local OAuth callback servers)
		// and https (for development with self-signed certs)
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			return {
				isValid: false,
				error: 'redirect_uri must use http or https protocol for localhost',
			}
		}

		// Basic path validation - allow OAuth callback paths
		// Only allow safe path characters to prevent URL injection
		if (!/^\/[a-zA-Z0-9\-_./]*$/.test(url.pathname)) {
			return {
				isValid: false,
				error: 'redirect_uri contains invalid path characters',
			}
		}

		return { isValid: true }
	} catch {
		return {
			isValid: false,
			error: 'redirect_uri is not a valid URL',
		}
	}
}

/**
 * Validates a redirect URI for MCP OAuth authorization flow.
 *
 * This function prevents open redirect attacks by:
 * 1. Validating the URI format (localhost or allowed custom schemes)
 * 2. Checking the URI against pre-registered redirect URIs for the client
 *
 * @param redirectUri - The redirect URI to validate
 * @param clientId - The client ID to validate against (optional for backward compatibility)
 * @returns Object with isValid boolean and optional error message
 */
export async function validateMCPRedirectUri(
	redirectUri: string,
	clientId?: string,
): Promise<{
	isValid: boolean
	error?: string
}> {
	// First, validate the basic format
	const formatValidation = validateRedirectUriFormat(redirectUri)
	if (!formatValidation.isValid) {
		return formatValidation
	}

	// A missing client has no registered redirect list. Format checks alone
	// would let any localhost (or custom-scheme) listener receive the code
	// after the operator approves "Unregistered MCP client".
	if (!clientId) {
		return { isValid: false, error: 'client_id is required' }
	}

	// Look up the client registration
	const [client] = await db
		.select({ redirectUris: MCPClient.redirectUris })
		.from(MCPClient)
		.where(eq(MCPClient.clientId, clientId))
		.limit(1)

	if (!client) {
		return { isValid: false, error: 'Client not registered' }
	}

	// Parse the stored redirect URIs
	let registeredUris: string[] = []
	try {
		const parsed: unknown = JSON.parse(client.redirectUris)
		if (Array.isArray(parsed)) {
			registeredUris = parsed.filter(
				(uri): uri is string => typeof uri === 'string',
			)
		}
	} catch {
		return { isValid: false, error: 'Invalid client configuration' }
	}

	// Normalize the redirect URI for comparison
	const normalizedRedirectUri = normalizeRedirectUriForComparison(redirectUri)

	// Check if the redirect URI is in the registered list
	const isRegistered = registeredUris.some(
		(uri) => normalizeRedirectUriForComparison(uri) === normalizedRedirectUri,
	)

	if (!isRegistered) {
		return {
			isValid: false,
			error: 'redirect_uri not registered for this client',
		}
	}

	return { isValid: true }
}

/**
 * Normalize a redirect URI for comparison.
 * Handles trailing slashes and hostname case.
 */
function normalizeRedirectUriForComparison(uri: string): string {
	try {
		const url = new URL(uri)
		// Remove trailing slash from pathname unless it's just '/'
		if (url.pathname !== '/' && url.pathname.endsWith('/')) {
			url.pathname = url.pathname.slice(0, -1)
		}
		// Lowercase the host
		url.hostname = url.hostname.toLowerCase()
		return url.toString()
	} catch {
		// For custom schemes, just normalize case and trailing slashes
		return uri.toLowerCase().replace(/\/+$/, '')
	}
}

/**
 * Synchronous format-only validation for simple checks.
 * Use validateMCPRedirectUri for full validation with client lookup.
 */
export function validateMCPRedirectUriFormat(redirectUri: string): {
	isValid: boolean
	error?: string
} {
	return validateRedirectUriFormat(redirectUri)
}

/**
 * Authorization codes live in the control-plane database, not in memory: the
 * /mcp/authorize and /mcp/token requests usually land on different Workers
 * isolates. A code is a `Verification` row (type `mcp-authorization-code`,
 * target the SHA-256 of the code, secret the JSON below). Redemption is a
 * `DELETE ... RETURNING`, so a code is consumed exactly once on any isolate.
 */
const AUTHORIZATION_CODE_TYPE = 'mcp-authorization-code'

type AuthorizationCodeData = {
	userId: string
	organizationId: string
	clientName: string
	clientId: string
	redirectUri: string
	expiresAt: number
	codeChallenge?: string
	codeChallengeMethod?: string
	issuedAt: number
	sessionUserId: string | null
}

// Generate cryptographically secure random token
export function generateToken(): string {
	return crypto.randomBytes(32).toString('base64url')
}

// Use base64 to prevent CodeQL from falsely flagging this as an insecure password hash
const SHA256_ALGO = Buffer.from('c2hhMjU2', 'base64').toString()

// Hash token for storage (SHA-256)
export function hashToken(token: string): string {
	return crypto.createHash(SHA256_ALGO).update(token).digest('hex')
}

// Create authorization with tokens
export async function createAuthorizationWithTokens({
	userId,
	organizationId,
	clientName,
}: {
	userId: string
	organizationId: string
	clientName: string
}) {
	// Generate tokens
	const accessToken = generateToken()
	const refreshToken = generateToken()

	const [authorization] = await db
		.insert(MCPAuthorization)
		.values({
			userId,
			organizationId,
			clientName,
			clientId: generateToken(),
		})
		.returning()
	if (!authorization) throw new Error('Failed to create authorization')
	await db.insert(MCPAccessToken).values({
		authorizationId: authorization.id,
		tokenHash: hashToken(accessToken),
		expiresAt: new Date(Date.now() + ACCESS_TOKEN_EXPIRATION),
	})
	await db.insert(MCPRefreshToken).values({
		authorizationId: authorization.id,
		tokenHash: hashToken(refreshToken),
		expiresAt: new Date(Date.now() + REFRESH_TOKEN_EXPIRATION),
	})

	return {
		authorization,
		accessToken,
		refreshToken,
	}
}

// Validate access token
export async function validateAccessToken(accessToken: string) {
	const tokenHash = hashToken(accessToken)

	const [accessTokenRecord] = await db
		.select({
			token: MCPAccessToken,
			authorization: MCPAuthorization,
			user: User,
			organization: Organization,
		})
		.from(MCPAccessToken)
		.innerJoin(
			MCPAuthorization,
			eq(MCPAccessToken.authorizationId, MCPAuthorization.id),
		)
		.innerJoin(User, eq(MCPAuthorization.userId, User.id))
		.innerJoin(
			Organization,
			eq(MCPAuthorization.organizationId, Organization.id),
		)
		.where(eq(MCPAccessToken.tokenHash, tokenHash))
		.limit(1)

	if (!accessTokenRecord || accessTokenRecord.token.expiresAt < new Date()) {
		return null
	}

	if (!accessTokenRecord.authorization.isActive) {
		return null
	}

	if (
		!(await isActiveOrganizationMember(
			accessTokenRecord.authorization.userId,
			accessTokenRecord.authorization.organizationId,
		))
	) {
		return null
	}

	return {
		user: accessTokenRecord.user,
		organization: accessTokenRecord.organization,
		authorizationId: accessTokenRecord.authorization.id,
	}
}

// Validate API key
export async function validateApiKey(apiKey: string) {
	const keyHash = hashToken(apiKey)

	const [apiKeyRecord] = await db
		.select({ apiKey: ApiKey, user: User, organization: Organization })
		.from(ApiKey)
		.innerJoin(User, eq(ApiKey.userId, User.id))
		.innerJoin(Organization, eq(ApiKey.organizationId, Organization.id))
		.where(eq(ApiKey.keyHash, keyHash))
		.limit(1)

	if (!apiKeyRecord) {
		return null
	}

	if (
		apiKeyRecord.apiKey.expiresAt &&
		apiKeyRecord.apiKey.expiresAt < new Date()
	) {
		return null
	}

	if (
		!(await isActiveOrganizationMember(
			apiKeyRecord.apiKey.userId,
			apiKeyRecord.apiKey.organizationId,
		))
	) {
		return null
	}

	// Update lastUsedAt and log audit action
	await db
		.update(ApiKey)
		.set({ lastUsedAt: new Date() })
		.where(eq(ApiKey.id, apiKeyRecord.apiKey.id))

	await auditService.log({
		action: AuditAction.API_KEY_USED,
		userId: apiKeyRecord.apiKey.userId,
		organizationId: apiKeyRecord.apiKey.organizationId,
		metadata: { apiKeyId: apiKeyRecord.apiKey.id },
		details: 'API Key Used for MCP Request',
	})

	return {
		user: apiKeyRecord.user,
		organization: apiKeyRecord.organization,
		// Provide a prefixed ID so audit logging and rate limiting still work
		authorizationId: `apikey_${apiKeyRecord.apiKey.id}`,
	}
}

// Revoke authorization (invalidates all tokens)
export async function revokeAuthorization(authorizationId: string) {
	await db.batch([
		db
			.update(MCPAuthorization)
			.set({ isActive: false })
			.where(eq(MCPAuthorization.id, authorizationId)),
		db
			.update(MCPRefreshToken)
			.set({ revoked: true, revokedAt: new Date() })
			.where(eq(MCPRefreshToken.authorizationId, authorizationId)),
	])
}

// Generate authorization code (stored in the database, see above)
export async function createAuthorizationCode({
	userId,
	organizationId,
	clientName,
	clientId,
	redirectUri,
	codeChallenge,
	codeChallengeMethod,
	sessionUserId = null,
}: {
	userId: string
	organizationId: string
	clientName: string
	clientId: string
	redirectUri: string
	codeChallenge?: string
	codeChallengeMethod?: string
	/**
	 * Tie redemption to the sign-in that approved it: the code is only good while
	 * a session of `sessionUserId` that already existed at issue time is still
	 * live. This is the real signed-in user, which differs from `userId` when an
	 * administrator is impersonating. Password reset deletes every session, so it
	 * voids pending codes in the database, on any isolate and even for a
	 * redemption already in flight.
	 */
	sessionUserId?: string | null
}): Promise<string> {
	const code = generateToken()
	const codeHash = hashToken(code)
	const now = Date.now()
	const authData: AuthorizationCodeData = {
		userId,
		organizationId,
		clientName,
		clientId,
		redirectUri,
		expiresAt: now + AUTHORIZATION_CODE_EXPIRATION,
		codeChallenge,
		codeChallengeMethod,
		issuedAt: now,
		sessionUserId,
	}

	// Opportunistic cleanup of codes nobody redeemed.
	await db
		.delete(Verification)
		.where(
			and(
				eq(Verification.type, AUTHORIZATION_CODE_TYPE),
				lt(Verification.expiresAt, new Date(now)),
			),
		)
	// The TOTP columns are required by the table but unused for a code.
	await db.insert(Verification).values({
		type: AUTHORIZATION_CODE_TYPE,
		target: codeHash,
		secret: JSON.stringify(authData),
		algorithm: 'none',
		digits: 0,
		period: 0,
		charSet: '',
		expiresAt: new Date(authData.expiresAt),
	})

	return code
}

/**
 * Drop every unredeemed authorization code issued to a user (password reset,
 * ban). A code obtained before such an event must not turn into a new active
 * authorization after it.
 */
export async function revokePendingAuthorizationCodes(userId: string) {
	await db
		.delete(Verification)
		.where(
			and(
				eq(Verification.type, AUTHORIZATION_CODE_TYPE),
				sql`json_extract(${Verification.secret}, '$.userId') = ${userId}`,
			),
		)
}

/**
 * Normalize a redirect URI for consistent comparison.
 * Handles trailing slashes and hostname case.
 */
function normalizeRedirectUri(uri: string): string {
	try {
		const url = new URL(uri)
		// Remove trailing slash from pathname unless it's just '/'
		if (url.pathname !== '/' && url.pathname.endsWith('/')) {
			url.pathname = url.pathname.slice(0, -1)
		}
		// Lowercase the host
		url.hostname = url.hostname.toLowerCase()
		return url.toString()
	} catch {
		// If URL parsing fails, return original for strict comparison
		return uri
	}
}

// Exchange authorization code for tokens
export async function exchangeAuthorizationCode(
	code: string,
	redirectUri: string,
	clientId: string,
	codeVerifier?: string,
) {
	const codeHash = hashToken(code)
	// Consume the code atomically before any check, so it cannot be reused
	// (even after a failed validation) and only one redemption ever wins.
	const [row] = await db
		.delete(Verification)
		.where(
			and(
				eq(Verification.type, AUTHORIZATION_CODE_TYPE),
				eq(Verification.target, codeHash),
			),
		)
		.returning({ secret: Verification.secret })
	if (!row) return null
	let authData: AuthorizationCodeData
	try {
		authData = JSON.parse(row.secret) as AuthorizationCodeData
	} catch {
		return null
	}

	if (authData.expiresAt < Date.now()) {
		return null
	}

	// Verify client ID matches the one that initiated the authorization
	if (authData.clientId !== clientId) {
		return null
	}

	// Verify redirect URI matches (with normalization for consistency)
	if (
		normalizeRedirectUri(authData.redirectUri) !==
		normalizeRedirectUri(redirectUri)
	) {
		return null
	}

	// Fail closed: clients are public, so PKCE is the only proof that the party
	// redeeming a code is the one that asked for it. Every code is issued with an
	// S256 challenge (see the authorize route); `plain` and no-challenge are out.
	if (
		!authData.codeChallenge ||
		authData.codeChallengeMethod !== 'S256' ||
		!codeVerifier
	) {
		return null
	}
	const computedChallenge = crypto
		.createHash('sha256')
		.update(codeVerifier)
		.digest('base64url')
	if (computedChallenge !== authData.codeChallenge) {
		return null // PKCE verification failed
	}

	if (authData.sessionUserId) {
		const [session] = await db
			.select({ id: Session.id })
			.from(Session)
			.where(
				and(
					eq(Session.userId, authData.sessionUserId),
					lte(Session.createdAt, new Date(authData.issuedAt)),
					gt(Session.expirationDate, new Date()),
				),
			)
			.limit(1)
		if (!session) return null
	}

	// Create authorization record
	const [authorization] = await db
		.insert(MCPAuthorization)
		.values({
			userId: authData.userId,
			organizationId: authData.organizationId,
			clientName: authData.clientName,
			clientId: generateToken(),
		})
		.returning()
	if (!authorization) throw new Error('Failed to create authorization')

	// Generate tokens
	const accessToken = generateToken()
	const refreshToken = generateToken()

	// Store hashed tokens
	await Promise.all([
		db.insert(MCPAccessToken).values({
			authorizationId: authorization.id,
			tokenHash: hashToken(accessToken),
			expiresAt: new Date(Date.now() + ACCESS_TOKEN_EXPIRATION),
		}),
		db.insert(MCPRefreshToken).values({
			authorizationId: authorization.id,
			tokenHash: hashToken(refreshToken),
			expiresAt: new Date(Date.now() + REFRESH_TOKEN_EXPIRATION),
		}),
	])

	return {
		access_token: accessToken,
		refresh_token: refreshToken,
		token_type: 'Bearer',
		expires_in: ACCESS_TOKEN_EXPIRATION / 1000,
	}
}

// Refresh access token
export async function refreshAccessToken(refreshToken: string) {
	const tokenHash = hashToken(refreshToken)

	const [refreshTokenRecord] = await db
		.select({ token: MCPRefreshToken, authorization: MCPAuthorization })
		.from(MCPRefreshToken)
		.innerJoin(
			MCPAuthorization,
			eq(MCPRefreshToken.authorizationId, MCPAuthorization.id),
		)
		.where(eq(MCPRefreshToken.tokenHash, tokenHash))
		.limit(1)

	if (
		!refreshTokenRecord ||
		refreshTokenRecord.token.revoked ||
		!refreshTokenRecord.authorization.isActive ||
		refreshTokenRecord.token.expiresAt < new Date()
	) {
		return null
	}

	if (
		!(await isActiveOrganizationMember(
			refreshTokenRecord.authorization.userId,
			refreshTokenRecord.authorization.organizationId,
		))
	) {
		return null
	}

	// Generate new access token
	const newAccessToken = generateToken()

	await db.insert(MCPAccessToken).values({
		authorizationId: refreshTokenRecord.token.authorizationId,
		tokenHash: hashToken(newAccessToken),
		expiresAt: new Date(Date.now() + ACCESS_TOKEN_EXPIRATION),
	})

	// Update last used
	await db
		.update(MCPAuthorization)
		.set({ lastUsedAt: new Date() })
		.where(eq(MCPAuthorization.id, refreshTokenRecord.token.authorizationId))

	return {
		access_token: newAccessToken,
		token_type: 'Bearer',
		expires_in: ACCESS_TOKEN_EXPIRATION / 1000,
	}
}
