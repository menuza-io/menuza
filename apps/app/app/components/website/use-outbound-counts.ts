import { type ActionKind } from '@repo/common/action-targets'
import { useEffect, useState } from 'react'
import { z } from 'zod'

const credentialsSchema = z.object({
	jwt: z.string(),
	tenantApiUrl: z.string(),
})
const outboundSchema = z.object({
	outbound: z.object({
		order: z.number(),
		gift_cards: z.number(),
		reservations: z.number(),
	}),
})

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/**
 * Clicks that left for another site in the last 30 days (#318), read straight
 * from the region with a funnel token: counts only, no visitor. Null while
 * loading, when nothing leaves the site, or when the read fails.
 */
export function useOutboundCounts(orgSlug: string, enabled: boolean) {
	const [counts, setCounts] = useState<Record<ActionKind, number> | null>(null)
	useEffect(() => {
		if (!enabled) {
			setCounts(null)
			return
		}
		const controller = new AbortController()
		void (async () => {
			try {
				const tokenResponse = await fetch(
					`/${encodeURIComponent(orgSlug)}/funnel-token`,
					{
						headers: { Accept: 'application/json' },
						signal: controller.signal,
					},
				)
				if (!tokenResponse.ok) return
				const { jwt, tenantApiUrl } = credentialsSchema.parse(
					await tokenResponse.json(),
				)
				const to = Date.now()
				const params = new URLSearchParams({
					from: day(to - 29 * 86_400_000),
					to: day(to),
				})
				const response = await fetch(
					`${tenantApiUrl}/operator/funnel?${params}`,
					{
						headers: { Authorization: `Bearer ${jwt}` },
						signal: controller.signal,
					},
				)
				if (!response.ok) return
				setCounts(outboundSchema.parse(await response.json()).outbound)
			} catch {
				if (!controller.signal.aborted) setCounts(null)
			}
		})()
		return () => controller.abort()
	}, [orgSlug, enabled])
	return counts
}
