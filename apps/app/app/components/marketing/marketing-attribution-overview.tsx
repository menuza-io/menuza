import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { AttributionPanel, readAttributionView } from '@repo/marketing'
import { Skeleton } from '@repo/ui/skeleton'
import { useEffect, useState } from 'react'

type Overview = {
	messagesSent: number
	guestsReached: number
	view: ReturnType<typeof readAttributionView>
}

/**
 * The Marketing overview's "last 30 days" (#115): messages sent, the different
 * guests they reached, and the orders and revenue credited to marketing, with
 * the Clicked / Reached switch. All of it is counted in the region (counts and
 * amounts only reach the browser).
 */
export function MarketingAttributionOverview({
	jwt,
	tenantApiUrl,
}: {
	jwt: string | undefined
	tenantApiUrl: string
}) {
	const { _, i18n } = useLingui()
	const [overview, setOverview] = useState<Overview | null>(null)
	const [loading, setLoading] = useState(true)
	const [failed, setFailed] = useState(false)

	useEffect(() => {
		let cancelled = false
		async function load() {
			try {
				const res = await fetch(
					`${tenantApiUrl}/operator/marketing/attribution?days=30`,
					{ headers: { Authorization: `Bearer ${jwt}` } },
				)
				if (!res.ok) throw new Error('unavailable')
				const body = (await res.json()) as {
					attribution?: Record<string, unknown>
				}
				const raw = body.attribution ?? {}
				if (!cancelled) {
					setOverview({
						messagesSent: Number(raw.messagesSent) || 0,
						guestsReached: Number(raw.guestsReached) || 0,
						view: readAttributionView(raw),
					})
				}
			} catch {
				if (!cancelled) setFailed(true)
			} finally {
				if (!cancelled) setLoading(false)
			}
		}
		void load()
		return () => {
			cancelled = true
		}
	}, [jwt, tenantApiUrl])

	if (loading) return <Skeleton className="h-40 w-full rounded-lg" />
	if (failed || !overview) {
		return (
			<p className="text-muted-foreground text-sm" role="status">
				{_(msg`Orders and revenue from marketing could not be loaded.`)}
			</p>
		)
	}
	return (
		<AttributionPanel
			testId="marketing-attribution"
			view={overview.view}
			heading={
				<h2 className="text-sm font-medium">
					{_(msg`Last 30 days: messages and orders`)}
				</h2>
			}
			extra={
				<>
					<div className="rounded-lg border p-3">
						<dt className="text-muted-foreground text-xs">
							{_(msg`Messages sent`)}
						</dt>
						<dd
							className="mt-1 text-2xl tracking-tight tabular-nums"
							data-testid="marketing-messages-sent"
						>
							{overview.messagesSent.toLocaleString(i18n.locale)}
						</dd>
					</div>
					<div className="rounded-lg border p-3">
						<dt className="text-muted-foreground text-xs">
							{_(msg`Guests reached`)}
						</dt>
						<dd
							className="mt-1 text-2xl tracking-tight tabular-nums"
							data-testid="marketing-guests-reached"
						>
							{overview.guestsReached.toLocaleString(i18n.locale)}
						</dd>
					</div>
				</>
			}
		/>
	)
}
