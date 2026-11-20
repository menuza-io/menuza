import { readLiveEnv } from '#app/utils/env.server.ts'
import {
	type DomainAvailability,
	type RegistrantContact,
	type Registrar,
	RegistrarError,
	type RegistrarDomainInfo,
} from './adapters.server.ts'

/**
 * Name.com's Core API (v4) as the registrar (#183). The partner was an open
 * question in the issue; this adapter keeps the choice behind `Registrar`, so
 * moving to another partner means writing one more file, not changing the
 * product. Credentials: `NAMECOM_USERNAME`, `NAMECOM_API_TOKEN`
 * (`NAMECOM_API_URL` for the sandbox).
 */

type Json = Record<string, unknown>

function toContact(contact: RegistrantContact) {
	return {
		firstName: contact.firstName,
		lastName: contact.lastName,
		companyName: contact.organization,
		address1: contact.address1,
		address2: contact.address2 ?? '',
		city: contact.city,
		state: contact.state,
		zip: contact.postalCode,
		country: contact.country,
		phone: contact.phone,
		email: contact.email,
	}
}

const toCents = (value: unknown) => Math.round(Number(value ?? 0) * 100)

export class NameComRegistrar implements Registrar {
	readonly name = 'name.com'

	constructor(private readonly fetchImpl: typeof fetch = fetch) {}

	isConfigured() {
		return Boolean(
			readLiveEnv('NAMECOM_USERNAME') && readLiveEnv('NAMECOM_API_TOKEN'),
		)
	}

	private async call<T = Json>(path: string, init?: RequestInit): Promise<T> {
		const base = readLiveEnv('NAMECOM_API_URL') || 'https://api.name.com/v4'
		const credentials = btoa(
			`${readLiveEnv('NAMECOM_USERNAME')}:${readLiveEnv('NAMECOM_API_TOKEN')}`,
		)
		const response = await this.fetchImpl(`${base}${path}`, {
			...init,
			headers: {
				Authorization: `Basic ${credentials}`,
				'Content-Type': 'application/json',
				...init?.headers,
			},
			signal: AbortSignal.timeout(20_000),
		})
		const body = (await response.json().catch(() => ({}))) as Json
		if (!response.ok) {
			const message = String(body.message ?? body.details ?? response.status)
			throw new RegistrarError(
				response.status === 409 ? 'domain_unavailable' : 'provider_error',
				message,
			)
		}
		return body as T
	}

	async checkAvailability(fqdns: string[]): Promise<DomainAvailability[]> {
		const body = await this.call<{ results?: Json[] }>(
			'/domains:checkAvailability',
			{
				method: 'POST',
				body: JSON.stringify({ domainNames: fqdns }),
			},
		)
		return (body.results ?? []).map((result) => ({
			fqdn: String(result.domainName).toLowerCase(),
			available: result.purchasable === true,
			premium: result.premium === true,
			costCents: toCents(result.purchasePrice),
			renewalCostCents: toCents(result.renewalPrice ?? result.purchasePrice),
			currency: 'usd',
		}))
	}

	async register(input: Parameters<Registrar['register']>[0]) {
		const [availability] = await this.checkAvailability([input.fqdn])
		if (!availability?.available) throw new RegistrarError('domain_unavailable')
		const contact = toContact(input.contact)
		const body = await this.call<{ domain?: Json }>('/domains', {
			method: 'POST',
			body: JSON.stringify({
				domain: {
					domainName: input.fqdn,
					nameservers: input.nameservers,
					contacts: {
						registrant: contact,
						admin: contact,
						tech: contact,
						billing: contact,
					},
					privacyEnabled: input.privacy,
					locked: true,
					autorenewEnabled: input.autoRenew,
				},
				purchasePrice: availability.costCents / 100,
				purchaseType: 'registration',
				years: input.years,
			}),
		})
		return {
			registrarDomainId: String(body.domain?.domainName ?? input.fqdn),
			expiresAt: new Date(
				String(body.domain?.expireDate ?? Date.now() + 365 * 86_400_000),
			),
		}
	}

	async getDomain(fqdn: string): Promise<RegistrarDomainInfo | null> {
		try {
			const domain = await this.call(`/domains/${fqdn}`)
			return {
				fqdn,
				status: 'active',
				expiresAt: domain.expireDate
					? new Date(String(domain.expireDate))
					: null,
				autoRenew: domain.autorenewEnabled === true,
				locked: domain.locked === true,
				privacy: domain.privacyEnabled === true,
				// The API does not report ICANN verification: the screen asks.
				registrantEmailConfirmed: null,
			}
		} catch (error) {
			if (error instanceof RegistrarError) return null
			throw error
		}
	}

	async setAutoRenew(fqdn: string, autoRenew: boolean) {
		await this.call(`/domains/${fqdn}:setAutorenew`, {
			method: 'POST',
			body: JSON.stringify({ autorenewEnabled: autoRenew }),
		})
	}

	async renew(fqdn: string, years: number) {
		const availability = await this.checkAvailability([fqdn])
		const renewal = availability[0]?.renewalCostCents ?? 0
		const body = await this.call<{ domain?: Json }>(`/domains/${fqdn}:renew`, {
			method: 'POST',
			body: JSON.stringify({ years, purchasePrice: renewal / 100 }),
		})
		return {
			expiresAt: new Date(
				String(body.domain?.expireDate ?? Date.now() + 365 * 86_400_000),
			),
		}
	}

	async getAuthCode(fqdn: string) {
		const body = await this.call<{ authCode?: string }>(
			`/domains/${fqdn}:getAuthCodeForDomain`,
		)
		if (!body.authCode) throw new RegistrarError('provider_error')
		return body.authCode
	}

	async setLock(fqdn: string, locked: boolean) {
		await this.call(`/domains/${fqdn}:${locked ? 'lock' : 'unlock'}`, {
			method: 'POST',
			body: '{}',
		})
	}

	async setNameservers(fqdn: string, nameservers: string[]) {
		await this.call(`/domains/${fqdn}:setNameservers`, {
			method: 'POST',
			body: JSON.stringify({ nameservers }),
		})
	}

	async transferIn(input: Parameters<Registrar['transferIn']>[0]) {
		try {
			const body = await this.call<{ transfer?: Json }>('/transfers', {
				method: 'POST',
				body: JSON.stringify({
					domainName: input.fqdn,
					authCode: input.authCode,
					privacyEnabled: input.privacy,
				}),
			})
			return {
				registrarDomainId: String(body.transfer?.domainName ?? input.fqdn),
				status: 'pending' as const,
			}
		} catch (error) {
			if (error instanceof RegistrarError) {
				const text = error.message.toLowerCase()
				if (text.includes('lock')) throw new RegistrarError('locked')
				if (text.includes('auth')) throw new RegistrarError('invalid_auth_code')
				if (text.includes('60') || text.includes('recent'))
					throw new RegistrarError('too_new')
				throw new RegistrarError('transfer_failed')
			}
			throw error
		}
	}

	async resendRegistrantVerification() {
		// The registrar sends the ICANN email itself; the API has no resend.
	}
}
