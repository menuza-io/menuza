import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Switch } from '@repo/ui/switch'
import { useFetcher } from 'react-router'

export type ReadyTextLocation = { id: string; name: string; enabled: boolean }

/**
 * Settings, Terminals: "Text guests when their order is ready", per location.
 * Station then offers "Text me when it's ready" at checkout, and the region
 * texts counter and phone orders once when Kitchen marks them ready. Only
 * where the region can send texts (the US today).
 */
export function ReadyTextSettings({
	orgSlug,
	canWrite,
	smsAvailable,
	locations,
}: {
	orgSlug: string
	canWrite: boolean
	smsAvailable: boolean
	locations: ReadyTextLocation[]
}) {
	const { _ } = useLingui()
	if (locations.length === 0) return null
	return (
		<Card
			role="region"
			aria-label={_(t`Ready texts`)}
			className="min-w-0 shadow-none"
		>
			<CardHeader className="gap-2 border-b">
				<CardTitle as="h3">
					<Trans>Text guests when their order is ready</Trans>
				</CardTitle>
				<CardDescription className="max-w-prose leading-relaxed">
					{smsAvailable ? (
						<Trans>
							On a pickup order, Station asks for an optional number next to the
							guest’s name. When the kitchen marks the order ready, the guest
							gets one text. Phone orders are texted on their callback number.
							The number is used for that order only.
						</Trans>
					) : (
						<Trans>Texts are not available in your data region yet.</Trans>
					)}
				</CardDescription>
			</CardHeader>
			{smsAvailable ? (
				<CardContent className="flex min-w-0 flex-col divide-y">
					{locations.map((location) => (
						<ReadyTextRow
							key={location.id}
							orgSlug={orgSlug}
							canWrite={canWrite}
							location={location}
						/>
					))}
				</CardContent>
			) : null}
		</Card>
	)
}

function ReadyTextRow({
	orgSlug,
	canWrite,
	location,
}: {
	orgSlug: string
	canWrite: boolean
	location: ReadyTextLocation
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<{ ok: boolean; error: string | null }>()
	const pending = fetcher.formData?.get('enabled')
	const enabled = pending !== undefined ? pending === 'true' : location.enabled
	const name = location.name
	const failed = fetcher.state === 'idle' && fetcher.data && !fetcher.data.ok
	const message = !failed
		? ''
		: fetcher.data?.error === 'sms_unavailable'
			? _(t`Texts are not available in your data region yet.`)
			: fetcher.data?.error === 'location_not_found'
				? _(t`This location no longer exists. Reload the page.`)
				: _(t`That did not save. Try again.`)
	return (
		<div className="flex flex-col gap-1 py-2">
			<label className="flex min-h-11 items-center justify-between gap-4">
				<span className="min-w-0 wrap-anywhere">{name}</span>
				<Switch
					checked={enabled}
					// Kept focusable while saving, so the keyboard does not lose its place.
					disabled={!canWrite}
					aria-busy={fetcher.state !== 'idle' || undefined}
					aria-label={_(t`Text guests at ${name} when their order is ready`)}
					onCheckedChange={(checked) => {
						if (fetcher.state !== 'idle') return
						void fetcher.submit(
							{ locationId: location.id, enabled: checked ? 'true' : 'false' },
							{
								method: 'POST',
								action: `/${orgSlug}/settings/terminals/ready-text`,
							},
						)
					}}
				/>
			</label>
			<p role="status" className="text-destructive text-sm empty:hidden">
				{message}
			</p>
		</div>
	)
}
