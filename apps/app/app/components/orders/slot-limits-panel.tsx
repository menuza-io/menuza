import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { useCallback, useEffect, useState } from 'react'
import { Form, useFetcher } from 'react-router'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'

export type SlotLimitsLocation = {
	id: string
	name: string
	timezone: string
}

export type SlotLimitsToday = {
	enabled: boolean
	unit: 'orders' | 'dishes' | null
	limit: number | null
	exemptItems: number
	exemptCategories: number
	slots: Array<{
		at: string
		used: number
		limit: number | null
		remaining: number | null
	}>
}

function formatSlotTime(iso: string, timeZone: string, locale: string) {
	try {
		return new Intl.DateTimeFormat(locale, {
			timeZone,
			hour: 'numeric',
			minute: '2-digit',
		}).format(new Date(iso))
	} catch {
		return new Date(iso).toLocaleTimeString(locale)
	}
}

/**
 * Shows current and upcoming slot capacity on the Orders page when the org flag
 * is on and the location enables per-slot limits.
 */
export function SlotLimitsPanel({
	orgSlug,
	locations,
	canWrite,
	request,
}: {
	orgSlug: string
	locations: SlotLimitsLocation[]
	canWrite: boolean
	request: (path: string, init?: RequestInit) => Promise<unknown>
}) {
	const { _, i18n } = useLingui()
	const resetFetcher = useFetcher<{ ok: boolean; error?: string }>()
	const [fulfillment, setFulfillment] = useState<'pickup' | 'delivery'>(
		'pickup',
	)
	const [activeLocationId, setActiveLocationId] = useState(
		locations[0]?.id ?? '',
	)
	const [data, setData] = useState<SlotLimitsToday | null>(null)
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [confirmOpen, setConfirmOpen] = useState(false)

	const location =
		locations.find((row) => row.id === activeLocationId) ?? locations[0]

	const load = useCallback(async () => {
		if (!location) return
		setLoading(true)
		setError(null)
		try {
			const params = new URLSearchParams({
				locationId: location.id,
				fulfillment,
			})
			const body = (await request(
				`/limits/today?${params.toString()}`,
			)) as SlotLimitsToday
			setData(body)
		} catch (error) {
			if (
				error instanceof OperatorRequestError &&
				error.status === 404 &&
				error.code === 'slot_limits_disabled'
			) {
				setData(null)
				return
			}
			setError(_(msg`Could not load slot limits.`))
		} finally {
			setLoading(false)
		}
	}, [_, fulfillment, location, request])

	useEffect(() => {
		void load()
	}, [load])

	useEffect(() => {
		if (resetFetcher.state === 'idle' && resetFetcher.data?.ok) {
			setConfirmOpen(false)
			void load()
		}
	}, [load, resetFetcher.data, resetFetcher.state])

	if (locations.length === 0 || !location) return null

	const resetPending = resetFetcher.state !== 'idle'

	return (
		<section
			className="space-y-3 rounded-lg border p-4"
			aria-labelledby="slot-limits-title"
			data-testid="slot-limits-panel"
		>
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div>
					<h2 id="slot-limits-title" className="font-medium">
						<Trans>Order limits</Trans>
					</h2>
					<p className="text-muted-foreground text-sm">
						<Trans>Capacity for each 15-minute ready-time slot.</Trans>
					</p>
				</div>
				{locations.length > 1 ? (
					<label className="flex items-center gap-2 text-sm">
						<span className="text-muted-foreground">
							<Trans>Location</Trans>
						</span>
						<select
							className="border-input bg-background rounded-md border px-2 py-1"
							value={activeLocationId}
							onChange={(event) => setActiveLocationId(event.target.value)}
						>
							{locations.map((row) => (
								<option key={row.id} value={row.id}>
									{row.name}
								</option>
							))}
						</select>
					</label>
				) : null}
			</div>

			<div className="flex flex-wrap gap-2">
				<Button
					type="button"
					size="sm"
					variant={fulfillment === 'pickup' ? 'secondary' : 'outline'}
					onClick={() => setFulfillment('pickup')}
				>
					<Trans>Pickup</Trans>
				</Button>
				<Button
					type="button"
					size="sm"
					variant={fulfillment === 'delivery' ? 'secondary' : 'outline'}
					onClick={() => setFulfillment('delivery')}
				>
					<Trans>Delivery</Trans>
				</Button>
			</div>

			{loading ? (
				<p className="text-muted-foreground text-sm">
					<Trans>Loading…</Trans>
				</p>
			) : null}
			{error ? <p className="text-destructive text-sm">{error}</p> : null}
			{data?.enabled ? (
				<>
					<p className="text-muted-foreground text-sm">
						{data.unit === 'dishes' ? (
							<Trans>
								Limit is {data.limit ?? '—'} dishes per slot
								{data.exemptItems > 0 || data.exemptCategories > 0
									? ` (${data.exemptItems} dishes and ${data.exemptCategories} categories are not counted)`
									: ''}
								.
							</Trans>
						) : (
							<Trans>Limit is {data.limit ?? '—'} orders per slot.</Trans>
						)}
					</p>
					{data.slots.length > 0 ? (
						<ul className="divide-border divide-y text-sm">
							{data.slots.map((slot) => (
								<li
									key={slot.at}
									className="flex items-center justify-between gap-2 py-2"
								>
									<span>
										{formatSlotTime(slot.at, location.timezone, i18n.locale)}
									</span>
									<span className="text-muted-foreground tabular-nums">
										{slot.limit == null ? (
											<Trans>{slot.used} used</Trans>
										) : (
											<Trans>
												{slot.used} / {slot.limit}
												{slot.remaining != null
													? ` (${slot.remaining} left)`
													: ''}
											</Trans>
										)}
									</span>
								</li>
							))}
						</ul>
					) : (
						<p className="text-muted-foreground text-sm">
							<Trans>No open slots right now.</Trans>
						</p>
					)}
					{canWrite ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => setConfirmOpen(true)}
							disabled={resetPending}
						>
							<Trans>Reset counters</Trans>
						</Button>
					) : null}
				</>
			) : !loading && !error ? (
				<p className="text-muted-foreground text-sm">
					<Trans>Slot limits are off for this location.</Trans>
				</p>
			) : null}

			<Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							<Trans>Reset slot counters?</Trans>
						</DialogTitle>
						<DialogDescription>
							<Trans>
								Clears counts for this and later slots at {location.name}. Open
								orders are counted again from their lines.
							</Trans>
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setConfirmOpen(false)}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Form
							method="post"
							action={`/${orgSlug}/orders/slot-limits-reset`}
							onSubmit={(event) => {
								event.preventDefault()
								const form = event.currentTarget
								void resetFetcher.submit(form, { method: 'post' })
							}}
						>
							<input type="hidden" name="locationId" value={location.id} />
							<Button type="submit" disabled={resetPending}>
								<Trans>Reset counters</Trans>
							</Button>
						</Form>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</section>
	)
}
