import {
	SSOConfiguration as SSOConfigurationTable,
	db,
	desc,
	eq,
} from '@repo/database'
import { type SSOConfiguration } from '@repo/database/types'
import { encrypt, decrypt, getSSOMasterKey } from '@repo/security'
import {
	discoverOIDCEndpoints,
	testEndpointConnectivity,
	type DiscoveryResult as OIDCDiscoveryResult,
	type EndpointConfiguration,
} from '@repo/sso'

const EMAIL_DOMAIN =
	/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/**
 * The domains an organization's IdP may sign people in for: lowercase,
 * de-duplicated, comma-separated. Null when the list is empty or invalid.
 */
export function normalizeAllowedEmailDomains(value: unknown): string | null {
	if (typeof value !== 'string') return null
	const domains = [
		...new Set(
			value
				.split(',')
				.map((domain) => domain.trim().toLowerCase())
				.filter(Boolean),
		),
	]
	if (domains.length === 0 || !domains.every((d) => EMAIL_DOMAIN.test(d))) {
		return null
	}
	return domains.join(',')
}

export interface SSOConfigInput {
	providerName: string
	issuerUrl: string
	clientId: string
	clientSecret: string
	scopes?: string
	autoDiscovery?: boolean
	pkceEnabled?: boolean
	autoProvision?: boolean
	defaultRole?: string
	attributeMapping?: Record<string, string>
	/** Comma-separated, normalized domains the IdP is trusted for. */
	allowedEmailDomains?: string | null
	requireVerifiedEmail?: boolean
}

export interface ConnectionTestResult {
	success: boolean
	message: string
	error?: string
	discoveredEndpoints?: {
		authorizationUrl?: string
		tokenUrl?: string
		userinfoUrl?: string
		revocationUrl?: string
	}
}

/**
 * Service for managing SSO configurations
 */
export class SSOConfigurationService {
	/**
	 * Create a new SSO configuration for an organization
	 */
	async createConfiguration(
		organizationId: string,
		config: SSOConfigInput,
		createdById?: string,
	): Promise<SSOConfiguration> {
		const masterKey = getSSOMasterKey()
		const encryptedSecret = encrypt(config.clientSecret, masterKey)

		const [created] = await db
			.insert(SSOConfigurationTable)
			.values({
				organizationId,
				providerName: config.providerName,
				issuerUrl: config.issuerUrl,
				clientId: config.clientId,
				clientSecret: encryptedSecret,
				scopes: config.scopes || 'openid email profile',
				autoDiscovery: config.autoDiscovery ?? true,
				pkceEnabled: config.pkceEnabled ?? true,
				autoProvision: config.autoProvision ?? true,
				defaultRole: config.defaultRole || 'member',
				attributeMapping: config.attributeMapping
					? JSON.stringify(config.attributeMapping)
					: null,
				allowedEmailDomains: config.allowedEmailDomains ?? null,
				requireVerifiedEmail: config.requireVerifiedEmail ?? false,
				createdById,
			})
			.returning()
		return created as SSOConfiguration
	}

	/**
	 * Update an existing SSO configuration
	 */
	async updateConfiguration(
		id: string,
		config: Partial<SSOConfigInput>,
	): Promise<SSOConfiguration> {
		const updateData: any = { ...config }

		// Encrypt client secret if provided
		if (config.clientSecret) {
			const masterKey = getSSOMasterKey()
			updateData.clientSecret = encrypt(config.clientSecret, masterKey)
		}

		// Handle attribute mapping
		if (config.attributeMapping) {
			updateData.attributeMapping = JSON.stringify(config.attributeMapping)
		}

		const [updated] = await db
			.update(SSOConfigurationTable)
			.set(updateData)
			.where(eq(SSOConfigurationTable.id, id))
			.returning()
		return updated as SSOConfiguration
	}

	/**
	 * Get SSO configuration for an organization
	 */
	async getConfiguration(
		organizationId: string,
	): Promise<SSOConfiguration | null> {
		const result = await db.query.SSOConfiguration.findFirst({
			where: eq(SSOConfigurationTable.organizationId, organizationId),
			with: { organization: true, user: true },
		})
		return result
			? ({ ...result, createdBy: result.user } as SSOConfiguration)
			: null
	}

	/**
	 * Get SSO configuration by ID
	 */
	async getConfigurationById(id: string): Promise<SSOConfiguration | null> {
		const result = await db.query.SSOConfiguration.findFirst({
			where: eq(SSOConfigurationTable.id, id),
			with: { organization: true, user: true },
		})
		return result
			? ({ ...result, createdBy: result.user } as SSOConfiguration)
			: null
	}

	/**
	 * Delete an SSO configuration
	 */
	async deleteConfiguration(id: string): Promise<void> {
		await db
			.delete(SSOConfigurationTable)
			.where(eq(SSOConfigurationTable.id, id))
	}

	/**
	 * Enable or disable SSO for an organization
	 */
	async toggleConfiguration(id: string, isEnabled: boolean): Promise<void> {
		await db
			.update(SSOConfigurationTable)
			.set({ isEnabled })
			.where(eq(SSOConfigurationTable.id, id))
	}

	/**
	 * Decrypt the client secret for a configuration
	 */
	async getDecryptedClientSecret(config: SSOConfiguration): Promise<string> {
		const masterKey = getSSOMasterKey()
		return decrypt(config.clientSecret, masterKey)
	}

	/**
	 * Test connection to the identity provider
	 */
	async testConnection(
		config: SSOConfiguration,
	): Promise<ConnectionTestResult> {
		try {
			let endpoints: EndpointConfiguration

			if (config.autoDiscovery) {
				// Try OIDC discovery first
				const discoveryResult = await discoverOIDCEndpoints(config.issuerUrl)

				if (!discoveryResult.success || !discoveryResult.endpoints) {
					return {
						success: false,
						message: `OIDC Discovery failed: ${discoveryResult.error}`,
						error: `OIDC Discovery failed: ${discoveryResult.error}`,
					}
				}
				endpoints = discoveryResult.endpoints
			} else {
				// Use manually configured endpoints
				endpoints = {
					authorizationUrl: config.authorizationUrl!,
					tokenUrl: config.tokenUrl!,
					userinfoUrl: config.userinfoUrl || undefined,
					revocationUrl: config.revocationUrl || undefined,
				}
			}

			// Test endpoint connectivity
			const connectivityTest = await testEndpointConnectivity(endpoints)

			if (
				!connectivityTest.authorizationEndpoint ||
				!connectivityTest.tokenEndpoint
			) {
				return {
					success: false,
					message: `Connection test failed: ${connectivityTest.errors.join(', ')}`,
					error: `Endpoint connectivity test failed: ${connectivityTest.errors.join(', ')}`,
				}
			}

			// Update last tested timestamp (only if config exists in database)
			if (config.id !== 'temp-test-config') {
				try {
					await db
						.update(SSOConfigurationTable)
						.set({ lastTested: new Date() })
						.where(eq(SSOConfigurationTable.id, config.id))
				} catch {
					// Don't fail the test if we can't update the timestamp
				}
			}

			return {
				success: true,
				message: `Connection test successful! All endpoints are reachable.${config.autoDiscovery ? ' OIDC discovery completed successfully.' : ''}`,
				discoveredEndpoints: {
					authorizationUrl: endpoints.authorizationUrl,
					tokenUrl: endpoints.tokenUrl,
					userinfoUrl: endpoints.userinfoUrl,
					revocationUrl: endpoints.revocationUrl,
				},
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : 'Unknown error occurred'
			return {
				success: false,
				message: `Connection test failed: ${errorMessage}`,
				error: errorMessage,
			}
		}
	}

	/**
	 * Discover OIDC endpoints from .well-known/openid-configuration
	 */
	async discoverEndpoints(issuerUrl: string): Promise<OIDCDiscoveryResult> {
		return discoverOIDCEndpoints(issuerUrl)
	}

	/**
	 * Get parsed attribute mapping for a configuration
	 */
	getAttributeMapping(config: SSOConfiguration): Record<string, string> {
		if (!config.attributeMapping) {
			return {
				email: 'email',
				name: 'name',
				username: 'preferred_username',
				firstName: 'given_name',
				lastName: 'family_name',
			}
		}

		try {
			return JSON.parse(config.attributeMapping) as Record<string, string>
		} catch {
			// Return default mapping if parsing fails
			return {
				email: 'email',
				name: 'name',
				username: 'preferred_username',
				firstName: 'given_name',
				lastName: 'family_name',
			}
		}
	}

	/**
	 * List all SSO configurations (for admin purposes)
	 */
	async listConfigurations(): Promise<SSOConfiguration[]> {
		const configs = await db.query.SSOConfiguration.findMany({
			with: { organization: true, user: true },
			orderBy: desc(SSOConfigurationTable.createdAt),
		})
		return configs.map(
			(config) => ({ ...config, createdBy: config.user }) as SSOConfiguration,
		)
	}
}

// Export singleton instance
export const ssoConfigurationService = new SSOConfigurationService()
