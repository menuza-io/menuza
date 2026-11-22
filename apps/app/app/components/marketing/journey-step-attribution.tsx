import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	attributionFigures,
	formatAttributionMoney,
	readAttributionView,
	type AttributionMode,
} from '@repo/marketing'
import { Skeleton } from '@repo/ui/skeleton'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { useEffect, useState } from 'react'
import { type JourneyStepLabel } from '#app/utils/marketing/journey-step-labels.ts'

type StepRow = {
	nodeId: string
	view: ReturnType<typeof readAttributionView>
}

/**
 * Orders and revenue per step of an automation (#115), with the Clicked /
 * Reached switch. Counted in the region; only counts and amounts arrive here.
 */
export function JourneyStepAttribution({
	journeyId,
	jwt,
	tenantApiUrl,
	labels,
}: {
	journeyId: string
	jwt: string | undefined
	tenantApiUrl: string
	labels: readonly JourneyStepLabel[]
}) {
	const { _, i18n } = useLingui()
	const [mode, setMode] = useState<AttributionMode>('clicked')
	const [rows, setRows] = useState<StepRow[] | null>(null)
	const [currency, setCurrency] = useState('usd')
	const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')

	useEffect(() => {
		const controller = new AbortController()
		async function load() {
			try {
				const res = await fetch(
					`${tenantApiUrl}/operator/journeys/${encodeURIComponent(journeyId)}/attribution`,
					{
						headers: { Authorization: `Bearer ${jwt}` },
						signal: controller.signal,
					},
				)
				if (!res.ok) throw new Error('unavailable')
				const body = (await res.json()) as {
					currency?: string
					steps?: Array<Record<string, unknown>>
				}
				setCurrency(body.currency || 'usd')
				setRows(
					(body.steps ?? []).map((step) => ({
						nodeId: String(step.nodeId ?? ''),
						view: readAttributionView(step),
					})),
				)
				setState('ready')
			} catch {
				if (!controller.signal.aborted) setState('failed')
			}
		}
		void load()
		return () => controller.abort()
	}, [journeyId, jwt, tenantApiUrl])

	const typeLabels: Record<string, string> = {
		action_email: _(msg`Email`),
		action_sms: _(msg`Text`),
		action_push: _(msg`Push`),
	}
	const labelFor = (nodeId: string) => {
		const found = labels.find((label) => label.nodeId === nodeId)
		if (!found) return nodeId
		const kind = typeLabels[found.type] ?? found.type
		return found.summary ? `${kind}: ${found.summary}` : kind
	}
	const clicked = mode === 'clicked'

	return (
		<section
			className="space-y-3"
			data-testid="journey-step-attribution"
			data-mode={mode}
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h2 className="text-sm font-medium">
					{_(msg`Orders and revenue by step`)}
				</h2>
				<ToggleGroup
					variant="segmented"
					aria-label={_(msg`How orders are counted`)}
					value={[mode]}
					onValueChange={(next) => {
						const picked = next[0]
						if (picked === 'clicked' || picked === 'reached') setMode(picked)
					}}
				>
					<ToggleGroupItem
						value="clicked"
						data-testid="step-attribution-clicked"
					>
						{_(msg`Clicked`)}
					</ToggleGroupItem>
					<ToggleGroupItem
						value="reached"
						data-testid="step-attribution-reached"
					>
						{_(msg`Reached`)}
					</ToggleGroupItem>
				</ToggleGroup>
			</div>
			{state === 'loading' ? (
				<Skeleton className="h-24 w-full rounded-lg" />
			) : state === 'failed' ? (
				<p role="status" className="text-muted-foreground text-sm">
					{_(msg`Orders and revenue by step could not be loaded.`)}
				</p>
			) : !rows || rows.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					{_(msg`No step has sent a message yet.`)}
				</p>
			) : (
				<div className="overflow-x-auto rounded-lg border">
					<Table>
						<TableHeader>
							<TableRow className="bg-muted/50">
								<TableHead>{_(msg`Step`)}</TableHead>
								<TableHead className="text-end">
									{clicked
										? _(msg`Orders after a click`)
										: _(msg`Orders from guests reached`)}
								</TableHead>
								<TableHead className="text-end">
									{clicked
										? _(msg`Revenue after a click`)
										: _(msg`Revenue from guests reached`)}
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map((row) => {
								const figures = attributionFigures(row.view, mode)
								return (
									<TableRow
										key={row.nodeId}
										data-testid={`step-attribution-${row.nodeId}`}
									>
										<TableCell dir="auto">{labelFor(row.nodeId)}</TableCell>
										<TableCell className="text-end tabular-nums">
											{figures.orders.toLocaleString(i18n.locale)}
										</TableCell>
										<TableCell className="text-end tabular-nums">
											{formatAttributionMoney(
												figures.revenueMinor,
												currency,
												i18n.locale,
											)}
										</TableCell>
									</TableRow>
								)
							})}
						</TableBody>
					</Table>
				</div>
			)}
			<p className="text-muted-foreground text-xs">
				{clicked
					? _(
							msg`Clicked: orders placed after a guest followed a link in that step's message. Revenue is net of refunds.`,
						)
					: _(
							msg`Reached: clicked orders plus orders from guests who were sent that step's message in the 14 days before. Each order is counted once.`,
						)}
			</p>
		</section>
	)
}
