import { invariant } from '@epic-web/invariant'
import {
	classifyLineType,
	type NumberCheck,
} from '@repo/common/sign-in-delivery'
import { assertSecretNotPlaceholder } from '@repo/security'
import { ENV } from 'varlock/env'
import { getBoundTenantApiService } from '#app/utils/tenant-api-service.server.ts'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'

/**
 * Asks the text provider about a phone number (#246): real or not, and the line
 * type and carrier. The App has no provider credentials: like the alert texts,
 * the lookup goes through the US tenant-api node (`POST /api/phone-lookup`,
 * internal token), which is behind a mockable adapter. Returns null when it
 * cannot be asked, so Admin says "could not check" and never guesses.
 */
export interface PhoneLookupProvider {
	readonly name: string
	lookup(e164: string): Promise<NumberCheck | null>
}

export class UsTenantApiPhoneLookup implements PhoneLookupProvider {
	readonly name = 'us-tenant-api'

	async lookup(e164: string): Promise<NumberCheck | null> {
		const token = ENV.INTERNAL_COMMAND_TOKEN
		invariant(
			token && token.length >= 16,
			'INTERNAL_COMMAND_TOKEN must be configured with >= 16 chars',
		)
		assertSecretNotPlaceholder('INTERNAL_COMMAND_TOKEN', token)
		const { tenantApiUrl } = resolveRegionalTenantApiUrls('us')
		const service = getBoundTenantApiService()
		const fetchImpl = service ? service.fetch.bind(service) : fetch
		try {
			const response = await fetchImpl(`${tenantApiUrl}/api/phone-lookup`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ to: e164 }),
				redirect: 'error',
				signal: AbortSignal.timeout(15_000),
			})
			if (!response.ok) {
				void response.body?.cancel().catch(() => undefined)
				return null
			}
			const body = (await response.json()) as {
				valid?: unknown
				lineType?: unknown
				carrier?: unknown
			}
			return {
				valid: body.valid === true,
				lineType: classifyLineType(body.lineType),
				carrier: typeof body.carrier === 'string' ? body.carrier : null,
			}
		} catch {
			return null
		}
	}
}

/** Deterministic emulator for `MOCKS=true` and the tests: the last digits decide. */
export class MockPhoneLookup implements PhoneLookupProvider {
	readonly name = 'mock'
	async lookup(e164: string): Promise<NumberCheck | null> {
		if (e164.endsWith('9999')) {
			return { valid: false, lineType: 'unknown', carrier: null }
		}
		if (e164.endsWith('0000')) {
			return { valid: true, lineType: 'landline', carrier: 'Mock Telecom' }
		}
		if (e164.endsWith('7777')) {
			return { valid: true, lineType: 'voip', carrier: 'Mock VoIP' }
		}
		return { valid: true, lineType: 'mobile', carrier: 'Mock Mobile' }
	}
}

let override: PhoneLookupProvider | null = null

/** Tests inject a provider; `null` restores the default choice. */
export function setPhoneLookupProvider(provider: PhoneLookupProvider | null) {
	override = provider
}

export function getPhoneLookupProvider(): PhoneLookupProvider {
	if (override) return override
	const mocks = String(process.env.MOCKS ?? '').toLowerCase() === 'true'
	return mocks ? new MockPhoneLookup() : new UsTenantApiPhoneLookup()
}
