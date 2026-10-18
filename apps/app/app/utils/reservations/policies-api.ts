import { z } from 'zod'
import {
	ReservationsApiError,
	type ReservationsScopedClient,
} from '#app/utils/reservations/reservations-client.ts'

/**
 * Payment policy setup, browser-direct with a `setup` token. A policy is plain
 * configuration (amounts, windows, terms text): no guest data. The currency
 * always comes from the location, never from the screen.
 */

const SETUP_BASE = '/operator/reservations/setup'

export const POLICY_KINDS = [
	'none',
	'card_guarantee',
	'deposit',
	'prepay',
] as const
export type PolicyKind = (typeof POLICY_KINDS)[number]

export const POLICY_REFUND_RULES = [
	'full_before_window',
	'none',
	'partial',
] as const
export type PolicyRefundRule = (typeof POLICY_REFUND_RULES)[number]

export const POLICY_LOCALES = ['en', 'ar', 'es', 'fr', 'de', 'zh'] as const
export type PolicyLocale = (typeof POLICY_LOCALES)[number]

export const policySchema = z.object({
	id: z.string(),
	locationId: z.string(),
	name: z.string(),
	kind: z.enum(POLICY_KINDS),
	amountMinor: z.number().int(),
	perCover: z.boolean(),
	currency: z.string(),
	freeCancelUntilMin: z.number().int(),
	lateCancelFeeMinor: z.number().int(),
	noShowFeeMinor: z.number().int(),
	feePerCover: z.boolean(),
	feeCapMinor: z.number().int().nullable(),
	refundRule: z.enum(POLICY_REFUND_RULES),
	partialRefundBp: z.number().int().nullable(),
	appliesPartyMin: z.number().int().nullable(),
	termsI18n: z.record(z.string(), z.string()).default({}),
	termsVersion: z.number().int(),
	archived: z.boolean(),
	version: z.number().int(),
})
export type PolicyDto = z.infer<typeof policySchema>

export type PolicyBody = {
	name: string
	kind: PolicyKind
	amountMinor: number
	perCover: boolean
	freeCancelUntilMin: number
	lateCancelFeeMinor: number
	noShowFeeMinor: number
	feePerCover: boolean
	feeCapMinor: number | null
	refundRule: PolicyRefundRule
	partialRefundBp: number | null
	appliesPartyMin: number | null
	termsI18n: Partial<Record<PolicyLocale, string>>
}

function malformed(): never {
	throw new ReservationsApiError('malformed_response', 502, {
		error: 'malformed_response',
	})
}

export async function fetchPolicies(
	client: ReservationsScopedClient,
	locationId: string,
	signal?: AbortSignal,
): Promise<PolicyDto[]> {
	const raw = await client.request<{ policies?: unknown }>(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/policies`,
		{ signal },
	)
	const parsed = z.array(policySchema).safeParse(raw.policies ?? [])
	return parsed.success ? parsed.data : malformed()
}

export async function createPolicy(
	client: ReservationsScopedClient,
	locationId: string,
	body: PolicyBody,
): Promise<PolicyDto> {
	const raw = await client.request<{ policy?: unknown }>(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/policies`,
		{ method: 'POST', body },
	)
	const parsed = policySchema.safeParse(raw.policy)
	return parsed.success ? parsed.data : malformed()
}

export async function updatePolicy(
	client: ReservationsScopedClient,
	locationId: string,
	policyId: string,
	body: PolicyBody,
	expectedVersion: number,
): Promise<PolicyDto> {
	const raw = await client.request<{ policy?: unknown }>(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/policies/${encodeURIComponent(policyId)}`,
		{ method: 'PUT', body: { ...body, expectedVersion } },
	)
	const parsed = policySchema.safeParse(raw.policy)
	return parsed.success ? parsed.data : malformed()
}

export async function archivePolicy(
	client: ReservationsScopedClient,
	locationId: string,
	policyId: string,
): Promise<void> {
	await client.request(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/policies/${encodeURIComponent(policyId)}`,
		{ method: 'DELETE' },
	)
}

export type PolicyAttachments = {
	/** Location currency (ISO 4217); policy amounts are in this currency. */
	currency: string
	settingsVersion: number
	defaultPolicyId: string | null
	services: Array<{ id: string; name: string; policyId: string | null }>
}

const str = (value: unknown): string | null =>
	typeof value === 'string' && value ? value : null

/**
 * Which policy applies where: the location default (`default_policy_id` in the
 * settings, whose version is shared with the other settings screens) and one
 * optional policy per service.
 */
export async function fetchPolicyAttachments(
	client: ReservationsScopedClient,
	locationId: string,
	signal?: AbortSignal,
): Promise<PolicyAttachments> {
	const base = `${SETUP_BASE}/locations/${encodeURIComponent(locationId)}`
	const [settingsRes, servicesRes] = await Promise.all([
		client.request<Record<string, unknown>>(`${base}/settings`, { signal }),
		client.request<{ services?: Array<Record<string, unknown>> }>(
			`${base}/services`,
			{ signal },
		),
	])
	const settings = (settingsRes.settings ?? settingsRes) as Record<
		string,
		unknown
	>
	const version = settings.version
	if (typeof version !== 'number') return malformed()
	return {
		currency: (str(settings.currency) ?? 'USD').toUpperCase(),
		settingsVersion: version,
		defaultPolicyId: str(
			settings.defaultPolicyId ?? settings.default_policy_id,
		),
		services: (servicesRes.services ?? [])
			.filter((service) => !service.archivedAt && !service.archived_at)
			.map((service) => ({
				id: String(service.id),
				name: String(service.name ?? service.id),
				policyId: str(service.policyId ?? service.policy_id),
			})),
	}
}

export async function setDefaultPolicy(
	client: ReservationsScopedClient,
	locationId: string,
	policyId: string | null,
	expectedVersion: number,
): Promise<void> {
	await client.request(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/settings`,
		{
			method: 'PUT',
			body: { defaultPolicyId: policyId, expectedVersion },
		},
	)
}

export async function setServicePolicy(
	client: ReservationsScopedClient,
	locationId: string,
	serviceId: string,
	policyId: string | null,
): Promise<void> {
	await client.request(
		`${SETUP_BASE}/locations/${encodeURIComponent(locationId)}/services/${encodeURIComponent(serviceId)}`,
		{ method: 'PUT', body: { policyId } },
	)
}
