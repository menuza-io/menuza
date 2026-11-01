import {
	DISCOUNT_USAGE_MAX_IDS,
	type DiscountUsageEntry,
	discountUsageResponseSchema,
} from '@repo/discounts'
import { z } from 'zod'

/**
 * Browser-direct usage counts. The App mints a short-lived token; the browser
 * asks the customer's region for counts only. Any failure resolves to `null`
 * so the page still renders (it shows "—").
 */

const REFRESH_SKEW_MS = 60_000

const tokenResponseSchema = z.object({
	jwt: z.string().min(1),
	tenantApiUrl: z.url(),
	expiresAt: z.number(),
})
type Token = z.infer<typeof tokenResponseSchema>

export type DiscountUsageClient = {
	/** Usage by discount id, or null when the region could not be reached. */
	fetchUsage(
		ids: readonly string[],
		signal?: AbortSignal,
		range?: { from?: string; to?: string },
	): Promise<Record<string, DiscountUsageEntry> | null>
}

export function createDiscountUsageClient({
	orgSlug,
	fetchImpl = (...args) => fetch(...args),
	now = () => Date.now(),
}: {
	orgSlug: string
	fetchImpl?: typeof fetch
	now?: () => number
}): DiscountUsageClient {
	let cached: Token | null = null

	async function token(): Promise<Token> {
		if (cached && cached.expiresAt - now() > REFRESH_SKEW_MS) return cached
		const response = await fetchImpl(
			`/${encodeURIComponent(orgSlug)}/discounts-token`,
			{
				headers: { Accept: 'application/json' },
				credentials: 'same-origin',
				cache: 'no-store',
			},
		)
		if (!response.ok) throw new Error(`token ${response.status}`)
		cached = tokenResponseSchema.parse(await response.json())
		return cached
	}

	return {
		async fetchUsage(ids, signal, range) {
			const unique = [...new Set(ids)]
			if (unique.length === 0) return {}
			// One request carries at most DISCOUNT_USAGE_MAX_IDS ids; ask in
			// chunks so a long list is not shown as zero uses.
			if (unique.length > DISCOUNT_USAGE_MAX_IDS) {
				const merged: Record<string, DiscountUsageEntry> = {}
				for (let at = 0; at < unique.length; at += DISCOUNT_USAGE_MAX_IDS) {
					const part = await this.fetchUsage(
						unique.slice(at, at + DISCOUNT_USAGE_MAX_IDS),
						signal,
						range,
					)
					if (part === null) return null
					Object.assign(merged, part)
				}
				return merged
			}
			try {
				const { jwt, tenantApiUrl } = await token()
				const url = new URL(
					`${tenantApiUrl.replace(/\/+$/, '')}/operator/discounts/usage`,
				)
				url.searchParams.set('ids', unique.join(','))
				if (range?.from) url.searchParams.set('from', range.from)
				if (range?.to) url.searchParams.set('to', range.to)
				const response = await fetchImpl(url.toString(), {
					headers: {
						Accept: 'application/json',
						Authorization: `Bearer ${jwt}`,
					},
					cache: 'no-store',
					signal,
				})
				if (!response.ok) {
					if (response.status === 401) cached = null
					return null
				}
				const parsed = discountUsageResponseSchema.parse(await response.json())
				return Object.fromEntries(
					parsed.usage.map((entry) => [entry.discountId, entry]),
				)
			} catch {
				return null
			}
		},
	}
}
