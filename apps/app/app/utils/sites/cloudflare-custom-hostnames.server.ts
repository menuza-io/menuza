import { isValidHostname, normalizeHostname } from '@repo/common/domains'
import { brand, getBrandDomain } from '@repo/config/brand'
import { ENV } from 'varlock/env'

export type CustomHostnameStatus =
	'pending' | 'active' | 'moved' | 'deleted' | 'blocked' | 'error'

export type CloudflareVerificationRecord = {
	type: string
	name: string
	value: string
}

export type CloudflareCustomHostname = {
	id: string
	hostname: string
	status: string
	sslStatus?: string
	/** `pending` or `verified`: ownership is shown apart from the certificate (#139). */
	ownershipStatus?: string
	ownershipVerification?: CloudflareVerificationRecord | null
	/** Certificate validation records (TXT or CNAME) Cloudflare asked for. */
	sslValidationRecords?: CloudflareVerificationRecord[]
	verificationErrors?: string[]
}

type CloudflareHostnameResult = {
	id: string
	hostname: string
	status?: string
	ssl?: {
		status?: string
		validation_records?: Array<{
			txt_name?: string
			txt_value?: string
			cname?: string
			cname_target?: string
		}>
	}
	ownership_verification?: {
		type?: string
		name?: string
		value?: string
	} | null
	verification_errors?: string[]
}

type CloudflareApiResult<T> = {
	success: boolean
	errors: Array<{ code?: number; message: string }>
	result: T
}

function getCloudflareConfig() {
	const apiToken = ENV.CLOUDFLARE_API_TOKEN?.trim() || ''
	const zoneId = ENV.CLOUDFLARE_ZONE_ID?.trim() || ''
	const cnameTarget =
		ENV.CLOUDFLARE_CUSTOM_HOSTNAME_CNAME_TARGET?.trim() ||
		`sites.${getBrandDomain()}`

	return {
		apiToken,
		zoneId,
		cnameTarget,
		isConfigured: Boolean(apiToken && zoneId),
	}
}

export function getCustomHostnameCnameTarget() {
	return getCloudflareConfig().cnameTarget
}

export function isCloudflareCustomHostnamesConfigured() {
	return getCloudflareConfig().isConfigured
}

function mapHostnameStatus(status: string | undefined): CustomHostnameStatus {
	switch (status) {
		case 'active':
			return 'active'
		case 'moved':
			return 'moved'
		case 'deleted':
		case 'pending_deletion':
			return 'deleted'
		case 'blocked':
		case 'pending_blocked':
			return 'blocked'
		case 'pending':
		case 'pending_validation':
		case 'pending_provisioned':
		case 'provisioned':
		case 'active_redeploying':
			return 'pending'
		default:
			return status ? 'pending' : 'error'
	}
}

async function cloudflareFetch<T>(
	path: string,
	init?: RequestInit,
): Promise<CloudflareApiResult<T>> {
	const { apiToken, zoneId } = getCloudflareConfig()
	if (!apiToken || !zoneId) {
		throw new Error('Cloudflare custom hostnames are not configured')
	}

	const response = await fetch(
		`https://api.cloudflare.com/client/v4/zones/${zoneId}${path}`,
		{
			...init,
			headers: {
				Authorization: `Bearer ${apiToken}`,
				'Content-Type': 'application/json',
				...init?.headers,
			},
		},
	)

	const data = (await response.json()) as CloudflareApiResult<T>
	if (!response.ok || !data.success) {
		const message =
			data.errors?.map((e) => e.message).join('; ') ||
			`Cloudflare API error (${response.status})`
		throw new Error(message)
	}

	return data
}

function normalizeHostnameResult(
	result: CloudflareHostnameResult,
): CloudflareCustomHostname {
	const status = mapHostnameStatus(result.status)
	return {
		id: result.id,
		hostname: result.hostname,
		status,
		sslStatus: result.ssl?.status,
		ownershipStatus: status === 'active' ? 'verified' : 'pending',
		ownershipVerification: result.ownership_verification?.name
			? {
					type: result.ownership_verification.type || 'txt',
					name: result.ownership_verification.name,
					value: result.ownership_verification.value || '',
				}
			: null,
		sslValidationRecords: (result.ssl?.validation_records ?? []).flatMap(
			(record): CloudflareVerificationRecord[] =>
				record.txt_name && record.txt_value
					? [{ type: 'txt', name: record.txt_name, value: record.txt_value }]
					: record.cname && record.cname_target
						? [
								{
									type: 'cname',
									name: record.cname,
									value: record.cname_target,
								},
							]
						: [],
		),
		verificationErrors: result.verification_errors ?? [],
	}
}

/**
 * Register a customer domain with Cloudflare for SaaS (Custom Hostnames).
 * When Cloudflare is not configured (local/dev), returns a synthetic pending hostname.
 */
export async function createCustomHostname(
	hostname: string,
): Promise<CloudflareCustomHostname> {
	const normalized = hostname.toLowerCase().trim()

	if (!isCloudflareCustomHostnamesConfigured()) {
		return {
			id: `local-${normalized}`,
			hostname: normalized,
			status: 'pending',
			sslStatus: 'pending_validation',
			ownershipVerification: null,
		}
	}

	const data = await cloudflareFetch<CloudflareHostnameResult>(
		'/custom_hostnames',
		{
			method: 'POST',
			body: JSON.stringify({
				hostname: normalized,
				ssl: {
					method: 'http',
					type: 'dv',
				},
				custom_metadata: {
					source: `${brand.slug}-sites`,
				},
			}),
		},
	)

	return normalizeHostnameResult(data.result)
}

export async function getCustomHostname(
	hostnameId: string,
): Promise<CloudflareCustomHostname | null> {
	if (
		!isCloudflareCustomHostnamesConfigured() ||
		hostnameId.startsWith('local-')
	) {
		return {
			id: hostnameId,
			hostname: hostnameId.replace(/^local-/, ''),
			status: 'active',
			sslStatus: 'active',
			ownershipVerification: null,
		}
	}

	try {
		const data = await cloudflareFetch<CloudflareHostnameResult>(
			`/custom_hostnames/${hostnameId}`,
		)
		return normalizeHostnameResult(data.result)
	} catch {
		return null
	}
}

/**
 * Asks Cloudflare to try the certificate validation again ("Check certificate
 * again", #139). Local deployments answer from the synthetic hostname.
 */
export async function retryCustomHostnameValidation(
	hostnameId: string,
): Promise<CloudflareCustomHostname | null> {
	if (
		!isCloudflareCustomHostnamesConfigured() ||
		hostnameId.startsWith('local-')
	) {
		return getCustomHostname(hostnameId)
	}
	const data = await cloudflareFetch<CloudflareHostnameResult>(
		`/custom_hostnames/${hostnameId}`,
		{
			method: 'PATCH',
			body: JSON.stringify({ ssl: { method: 'http', type: 'dv' } }),
		},
	)
	return normalizeHostnameResult(data.result)
}

export async function deleteCustomHostname(hostnameId: string): Promise<void> {
	if (
		!isCloudflareCustomHostnamesConfigured() ||
		hostnameId.startsWith('local-')
	) {
		return
	}

	await cloudflareFetch(`/custom_hostnames/${hostnameId}`, {
		method: 'DELETE',
	})
}

/**
 * Normalize and validate a customer hostname (no protocol/path/port, lower
 * case, punycode). The rules live in `@repo/common/domains`.
 */
export function normalizeCustomDomain(input: string): string {
	return normalizeHostname(input)
}

export function isValidCustomDomain(hostname: string): boolean {
	return isValidHostname(hostname)
}
