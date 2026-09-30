/**
 * Base class for POS/delivery provider integrations.
 *
 * POS providers reuse the shared `BaseIntegrationProvider` (so the existing
 * registry, `Integration` table and encryption plumbing keep working) but the
 * note-oriented surface is unsupported: a POS provider has no channels and does
 * not post messages.
 */

import {
	type Integration,
	type NoteIntegrationConnection,
} from '../../database-types'
import { BaseIntegrationProvider } from '../../provider'
import {
	type Channel,
	type MessageData,
	type OAuthCallbackParams,
	type ProviderType,
	type TokenData,
} from '../../types'
import { tokenManager } from '../../token-manager.ts'
import { requirePosAppCredentials } from '../oauth-shared.ts'
import { fetchUberEatsClientCredentialsToken } from '../uber-oauth.ts'
import { createAdapter, idempotencyKey, type Adapter } from '../adapter.ts'
import { PosError } from '../errors.ts'
import { parsePosConfig, resolveTransport } from '../transport.ts'
import {
	providerKind,
	providerNames,
	providerWriteMode,
	type PosProvider,
	type ProviderKind,
	type RemoteItem,
	type RemoteMenu,
	type RemoteRead,
	type WriteMode,
} from '../types.ts'

export interface PosIntegrationProvider extends BaseIntegrationProvider {
	/** `pos` for point-of-sale, `delivery` for delivery marketplaces. */
	readonly kind: ProviderKind
	/** How the platform accepts menu content. */
	readonly writeMode: WriteMode
	/** Icon sprite name. */
	readonly icon: string
	/** Build an adapter bound to the connection's stored config. */
	adapter(integration: Integration): Promise<Adapter>
	readCatalog(integration: Integration): Promise<RemoteRead>
	submitMenu(
		integration: Integration,
		items: RemoteItem[],
		menus: RemoteMenu[],
		baseVersion?: number,
	): Promise<void>
	setAvailability(
		integration: Integration,
		item: RemoteItem,
		available: boolean,
	): Promise<void>
	pause(integration: Integration, until: string | null): Promise<void>
}

export abstract class BasePosProvider
	extends BaseIntegrationProvider
	implements PosIntegrationProvider
{
	abstract readonly provider: PosProvider
	abstract readonly name: string
	abstract readonly displayName: string
	abstract readonly description: string
	abstract readonly icon: string

	get type(): ProviderType {
		return providerKind[this.provider]
	}
	get kind(): ProviderKind {
		return providerKind[this.provider]
	}
	get writeMode(): WriteMode {
		return providerWriteMode[this.provider]
	}
	get logoPath(): string {
		return `/icons/${this.icon}.svg`
	}

	async adapter(integration: Integration): Promise<Adapter> {
		const config = parsePosConfig(integration.config)
		if (this.provider === 'square' && config.locationId) {
			config.merchantId = config.locationId
		}
		// An OAuth connection stores its access token on the row (encrypted);
		// tokenManager decrypts it and refreshes it when it is close to expiry.
		const usesOAuth = Boolean(integration.accessToken)
		const accessToken = usesOAuth
			? await tokenManager.getValidAccessToken(integration, this)
			: null
		if (usesOAuth && !accessToken) {
			throw new PosError('Authorization expired. Reconnect and try again.', 401)
		}
		let apiAccessToken = accessToken
		if (this.provider === 'ubereats' && usesOAuth && accessToken) {
			const app = requirePosAppCredentials('ubereats')
			apiAccessToken = await fetchUberEatsClientCredentialsToken(app)
		}
		return createAdapter(
			this.provider,
			resolveTransport(this.provider, integration.id, config, {
				accessToken: apiAccessToken,
			}),
		)
	}

	async readCatalog(integration: Integration): Promise<RemoteRead> {
		try {
			return await (await this.adapter(integration)).read()
		} catch (error) {
			if (
				error instanceof PosError &&
				error.status === 401 &&
				integration.refreshToken
			) {
				const { integrationManager } =
					await import('../../integration-manager.ts')
				try {
					const updated = await integrationManager.refreshIntegrationTokens(
						integration.id,
					)
					return await (await this.adapter(updated)).read()
				} catch {
					// Fall through to the original Clover/API error.
				}
			}
			throw error
		}
	}

	async submitMenu(
		integration: Integration,
		items: RemoteItem[],
		menus: RemoteMenu[],
		baseVersion = 0,
	): Promise<void> {
		const adapter = await this.adapter(integration)
		if (adapter.writeMode !== 'menu') {
			throw new PosError(
				`${providerNames[this.provider]} does not accept full-menu submissions.`,
				400,
			)
		}
		await adapter.submitMenu(
			items,
			menus,
			baseVersion,
			idempotencyKey(
				this.provider,
				integration.id,
				baseVersion,
				JSON.stringify({ items, menus }),
			),
		)
	}

	async setAvailability(
		integration: Integration,
		item: RemoteItem,
		available: boolean,
	): Promise<void> {
		const catalog = await this.readCatalog(integration)
		await (
			await this.adapter(integration)
		).setAvailability(
			item,
			available,
			idempotencyKey(
				this.provider,
				integration.id,
				item.id,
				available,
				crypto.randomUUID(),
			),
			catalog.currency,
		)
	}

	async pause(integration: Integration, until: string | null): Promise<void> {
		await (await this.adapter(integration)).pause(until)
	}

	async validateConnection(
		connection: NoteIntegrationConnection & { integration: Integration },
	): Promise<boolean> {
		try {
			await this.readCatalog(connection.integration)
			return true
		} catch {
			return false
		}
	}

	getConfigSchema(): Record<string, any> {
		return {
			type: 'object',
			properties: {
				environment: { type: 'string', enum: ['sandbox', 'live'] },
				merchantId: { type: 'string' },
				locationId: { type: 'string' },
			},
			required: ['merchantId'],
		}
	}

	// --- POS providers are not note integrations ---------------------------------

	async getAuthUrl(
		_organizationId: string,
		_redirectUri: string,
		_additionalParams?: Record<string, any>,
	): Promise<string> {
		throw new PosError(
			`${this.displayName} connects with store credentials, not OAuth.`,
			400,
		)
	}

	async handleCallback(_params: OAuthCallbackParams): Promise<TokenData> {
		throw new PosError(
			`${this.displayName} does not use an OAuth callback.`,
			400,
		)
	}

	async refreshToken(_refreshToken: string): Promise<TokenData> {
		throw new PosError(
			`${this.displayName} does not issue refreshable tokens.`,
			400,
		)
	}

	async getAvailableChannels(_integration: Integration): Promise<Channel[]> {
		return []
	}

	async postMessage(
		_connection: NoteIntegrationConnection & { integration: Integration },
		_message: MessageData,
	): Promise<void> {
		throw new PosError(`${this.displayName} is not a note integration.`, 400)
	}
}
