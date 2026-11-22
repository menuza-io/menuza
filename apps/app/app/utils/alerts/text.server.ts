import { invariant } from '@epic-web/invariant'
import { assertSecretNotPlaceholder } from '@repo/security'
import { ENV } from 'varlock/env'
import { getBoundTenantApiService } from '#app/utils/tenant-api-service.server.ts'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'

/**
 * Texts to the people a location chose for order alerts (#241), behind one
 * small interface so tests and `MOCKS=true` never reach a provider. The App has
 * no SMS credentials: the only texting route is the US tenant-api node
 * (`POST /api/alert-texts`, internal token), exactly like the phone-line
 * verification. KSA organizations have no in-kingdom provider yet (#78), so
 * they get email only (`alertTextsAvailable`).
 */

export type AlertTextResult =
	| { ok: true }
	| { ok: false; code: 'unavailable' | 'rate_limited' | 'rejected' | 'failed' }

export interface AlertTextProvider {
	readonly name: string
	send(input: {
		orgId: string
		to: string
		text: string
	}): Promise<AlertTextResult>
}

/** Texts are offered only where a texting route exists: every region but KSA. */
export function alertTextsAvailable(dataRegion: string | null | undefined) {
	return (dataRegion || 'us') !== 'ksa'
}

export class UsTenantApiTextProvider implements AlertTextProvider {
	readonly name = 'us-tenant-api'

	async send(input: {
		orgId: string
		to: string
		text: string
	}): Promise<AlertTextResult> {
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
			const response = await fetchImpl(`${tenantApiUrl}/api/alert-texts`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(input),
				redirect: 'error',
				signal: AbortSignal.timeout(15_000),
			})
			void response.body?.cancel().catch(() => undefined)
			if (response.ok) return { ok: true }
			if (response.status === 429) return { ok: false, code: 'rate_limited' }
			if (response.status === 409 || response.status === 503) {
				return { ok: false, code: 'unavailable' }
			}
			return {
				ok: false,
				code: response.status >= 500 ? 'failed' : 'rejected',
			}
		} catch {
			return { ok: false, code: 'failed' }
		}
	}
}

/** In-memory emulator for `MOCKS=true` and the tests. */
export class MockAlertTextProvider implements AlertTextProvider {
	readonly name = 'mock'
	readonly sent: Array<{ orgId: string; to: string; text: string }> = []
	/** Numbers the "provider" refuses. */
	readonly failing = new Set<string>()

	async send(input: {
		orgId: string
		to: string
		text: string
	}): Promise<AlertTextResult> {
		if (this.failing.has(input.to)) return { ok: false, code: 'failed' }
		this.sent.push(input)
		return { ok: true }
	}

	reset() {
		this.sent.length = 0
		this.failing.clear()
	}
}

let override: AlertTextProvider | null = null
let mock: MockAlertTextProvider | null = null
let real: UsTenantApiTextProvider | null = null

/** Tests inject a provider; `null` restores the default choice. */
export function setAlertTextProvider(provider: AlertTextProvider | null) {
	override = provider
}

export function getMockAlertTextProvider(): MockAlertTextProvider {
	mock ??= new MockAlertTextProvider()
	return mock
}

export function getAlertTextProvider(): AlertTextProvider {
	if (override) return override
	const mocks = String(process.env.MOCKS ?? '').toLowerCase() === 'true'
	if (mocks || process.env.ALERT_TEXT_PROVIDER === 'mock') {
		return getMockAlertTextProvider()
	}
	real ??= new UsTenantApiTextProvider()
	return real
}
