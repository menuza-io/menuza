import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	SITE_DEVICES,
	SITE_ENTRIES,
	type SiteDevice,
	type SiteEntry,
	type SiteEventName,
} from '@repo/common/site-funnel'
import { Button } from '@repo/ui/button'
import { useCallback, useEffect, useState } from 'react'
import { z } from 'zod'

const stepSchema = z.object({
	event: z.string(),
	count: z.number(),
	rateFromPrevious: z.number().nullable(),
	rateFromStart: z.number().nullable(),
	previousCount: z.number(),
	changePoints: z.number().nullable(),
})
const funnelSchema = z.object({ steps: z.array(stepSchema) })
const credentialsSchema = z.object({
	jwt: z.string(),
	tenantApiUrl: z.string(),
})

type Funnel = z.infer<typeof funnelSchema>

const STEP_LABELS: Record<SiteEventName, ReturnType<typeof msg>> = {
	visit: msg`Visits`,
	menu_view: msg`Viewed the menu`,
	add_to_cart: msg`Added to cart`,
	checkout: msg`Started checkout`,
	order: msg`Placed an order`,
}
const DEVICE_LABELS: Record<SiteDevice, ReturnType<typeof msg>> = {
	phone: msg`Phone`,
	tablet: msg`Tablet`,
	desktop: msg`Desktop`,
}
const ENTRY_LABELS: Record<SiteEntry, ReturnType<typeof msg>> = {
	qr_poster: msg`Poster QR`,
	qr_table: msg`Table QR`,
	direct: msg`Direct`,
	marketing: msg`Marketing`,
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const percent = (value: number | null) =>
	value === null ? '—' : `${Math.round(value * 1000) / 10}%`

/**
 * Website funnel (#179): visit, menu, cart, checkout, order, with the share of
 * visitors who reach each step and how that changed since the period before.
 * Counts come straight from the region with a `funnel` token; they hold no
 * visitor, address or device identity.
 */
export function FunnelPanel({ orgSlug }: { orgSlug: string }) {
	const { _ } = useLingui()
	const [days, setDays] = useState(7)
	const [device, setDevice] = useState<SiteDevice | ''>('')
	const [entry, setEntry] = useState<SiteEntry | ''>('')
	const [funnel, setFunnel] = useState<Funnel | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [loading, setLoading] = useState(true)

	const load = useCallback(
		async (signal: AbortSignal) => {
			setLoading(true)
			setError(null)
			try {
				const tokenResponse = await fetch(
					`/${encodeURIComponent(orgSlug)}/funnel-token`,
					{ headers: { Accept: 'application/json' }, signal },
				)
				if (!tokenResponse.ok) throw new Error('token')
				const { jwt, tenantApiUrl } = credentialsSchema.parse(
					await tokenResponse.json(),
				)
				const to = Date.now()
				const params = new URLSearchParams({
					from: day(to - (days - 1) * 86_400_000),
					to: day(to),
				})
				if (device) params.set('device', device)
				if (entry) params.set('entry', entry)
				const response = await fetch(
					`${tenantApiUrl}/operator/funnel?${params}`,
					{ headers: { Authorization: `Bearer ${jwt}` }, signal },
				)
				if (!response.ok) throw new Error('funnel')
				setFunnel(funnelSchema.parse(await response.json()))
			} catch (cause) {
				if (signal.aborted) return
				setFunnel(null)
				setError(cause instanceof Error ? cause.message : 'funnel')
			} finally {
				if (!signal.aborted) setLoading(false)
			}
		},
		[orgSlug, days, device, entry],
	)

	useEffect(() => {
		const controller = new AbortController()
		void load(controller.signal)
		return () => controller.abort()
	}, [load])

	const visits = funnel?.steps[0]?.count ?? 0
	return (
		<section aria-labelledby="funnel-title" className="space-y-4">
			<div>
				<h2 id="funnel-title" className="text-lg font-medium">
					<Trans>Ordering funnel</Trans>
				</h2>
				<p className="text-muted-foreground mt-1 text-sm">
					<Trans>
						How many visitors get from your website to an order. Counted without
						identifying anyone: a visit is one browser session.
					</Trans>
				</p>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				{[7, 30, 90].map((option) => (
					<Button
						key={option}
						size="sm"
						variant={days === option ? 'secondary' : 'ghost'}
						aria-pressed={days === option}
						onClick={() => setDays(option)}
					>
						<Trans>Last {option} days</Trans>
					</Button>
				))}
				<select
					aria-label={_(msg`Device`)}
					value={device}
					onChange={(event) => setDevice(event.target.value as SiteDevice | '')}
					className="border-input bg-background h-9 rounded-md border px-2 text-sm"
				>
					<option value="">{_(msg`All devices`)}</option>
					{SITE_DEVICES.map((option) => (
						<option key={option} value={option}>
							{_(DEVICE_LABELS[option])}
						</option>
					))}
				</select>
				<select
					aria-label={_(msg`How the visit started`)}
					value={entry}
					onChange={(event) => setEntry(event.target.value as SiteEntry | '')}
					className="border-input bg-background h-9 rounded-md border px-2 text-sm"
				>
					<option value="">{_(msg`All sources`)}</option>
					{SITE_ENTRIES.map((option) => (
						<option key={option} value={option}>
							{_(ENTRY_LABELS[option])}
						</option>
					))}
				</select>
			</div>
			{error ? (
				<p role="alert" className="text-destructive text-sm">
					<Trans>Unable to load the funnel. Try again.</Trans>
				</p>
			) : loading && !funnel ? (
				<p role="status" className="text-muted-foreground text-sm">
					<Trans>Loading…</Trans>
				</p>
			) : visits === 0 ? (
				<p className="text-muted-foreground text-sm">
					<Trans>No visits counted in this period yet.</Trans>
				</p>
			) : (
				<ol className="space-y-2" aria-busy={loading}>
					{funnel!.steps.map((step) => {
						const width =
							visits > 0 ? Math.max(2, (step.count / visits) * 100) : 0
						return (
							<li key={step.event} className="space-y-1">
								<div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
									<span className="font-medium">
										{_(STEP_LABELS[step.event as SiteEventName])}
									</span>
									<span className="tabular-nums">
										{step.count.toLocaleString()}
										{step.rateFromStart !== null && step.event !== 'visit' ? (
											<span className="text-muted-foreground ms-2">
												{percent(step.rateFromStart)}
											</span>
										) : null}
										{step.changePoints !== null && step.event !== 'visit' ? (
											<span
												className={
													step.changePoints >= 0
														? 'ms-2 text-emerald-600'
														: 'text-destructive ms-2'
												}
											>
												{step.changePoints >= 0 ? '+' : ''}
												{step.changePoints} <Trans>pts vs previous</Trans>
											</span>
										) : null}
									</span>
								</div>
								<div
									className="bg-muted h-2 overflow-hidden rounded-full"
									aria-hidden
								>
									<div
										className="bg-primary h-full rounded-full"
										style={{ width: `${width}%` }}
									/>
								</div>
							</li>
						)
					})}
				</ol>
			)}
		</section>
	)
}
