import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { useState } from 'react'
import { useFetcher } from 'react-router'
import { TextField } from '#app/components/staff/controls.tsx'

/**
 * Settings, General: what a delivery app would have charged you, as a
 * percentage of the order total. It only sets the estimate "Kept by ordering
 * direct" on the monthly results; nothing is charged or changed by it.
 */
export function DeliveryCommissionCard({
	orgSlug,
	commissionBp,
	canEdit,
}: {
	orgSlug: string
	commissionBp: number
	canEdit: boolean
}) {
	const { t } = useLingui()
	const fetcher = useFetcher<{ ok: boolean; error?: string }>()
	const [percent, setPercent] = useState(String(commissionBp / 100))
	const value = Number(percent)
	const valid =
		percent.trim() !== '' && Number.isFinite(value) && value >= 0 && value <= 50
	return (
		<Card data-testid="delivery-commission-card">
			<CardHeader>
				<CardTitle>
					<Trans>Delivery-app commission</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						The share a delivery app usually takes from an order. It is used
						only to estimate how much ordering direct kept, on the monthly
						results.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				<TextField
					label={t`Commission rate (%)`}
					inputMode="decimal"
					value={percent}
					disabled={!canEdit}
					error={valid ? null : t`Enter a rate between 0 and 50.`}
					onChange={(event) => setPercent(event.target.value)}
					data-testid="delivery-commission-input"
				/>
				{canEdit ? (
					<Button
						className="self-start"
						disabled={!valid || fetcher.state !== 'idle'}
						onClick={() =>
							void fetcher.submit({ percent: value } as never, {
								method: 'post',
								encType: 'application/json',
								action: `/${orgSlug}/settings/delivery-commission`,
							})
						}
						data-testid="delivery-commission-save"
					>
						<Trans>Save rate</Trans>
					</Button>
				) : null}
				{fetcher.state === 'idle' && fetcher.data?.ok ? (
					<p role="status" className="text-muted-foreground text-sm">
						<Trans>Saved.</Trans>
					</p>
				) : null}
			</CardContent>
		</Card>
	)
}
