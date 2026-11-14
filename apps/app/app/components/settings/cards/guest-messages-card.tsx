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
import { type GuestMessageSwitches } from '#app/utils/guest-messages/settings.ts'

type SwitchKey = keyof GuestMessageSwitches

/**
 * Settings, Notifications: "Guest order messages". Three switches for the
 * emails guests get after an online order, each with a static preview of the
 * message. Shown only while `ordering.guest_messages` is on. Policy only: no
 * guest data is read or shown here.
 */
export function GuestMessagesCard({
	switches,
	canEdit,
}: {
	switches: GuestMessageSwitches
	canEdit: boolean
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<{ ok: boolean; error: string | null }>()
	const pending = fetcher.formData
	const current: GuestMessageSwitches = pending
		? {
				receipt: pending.get('receipt') === 'true',
				ready: pending.get('ready') === 'true',
				cancelled: pending.get('cancelled') === 'true',
			}
		: switches
	const failed = fetcher.state === 'idle' && fetcher.data && !fetcher.data.ok

	const rows: {
		key: SwitchKey
		label: string
		subject: string
		lines: string[]
	}[] = [
		{
			key: 'receipt',
			label: _(t`Order receipt`),
			subject: _(t`Your order is confirmed`),
			lines: [
				_(t`Thanks for your order. We have it and we are on it.`),
				_(t`Your items, the total and the pickup or delivery details.`),
			],
		},
		{
			key: 'ready',
			label: _(t`Order ready`),
			subject: _(t`Your order is ready`),
			lines: [
				_(t`Good news, your order is ready.`),
				_(t`Pick it up at the counter whenever you like.`),
			],
		},
		{
			key: 'cancelled',
			label: _(t`Order cancelled`),
			subject: _(t`Your order was cancelled`),
			lines: [
				_(t`We are sorry, we could not make your order.`),
				_(t`If you paid online, the money goes back to you.`),
			],
		},
	]

	const save = (key: SwitchKey, checked: boolean) => {
		if (fetcher.state !== 'idle') return
		const next = { ...current, [key]: checked }
		void fetcher.submit(
			{
				receipt: String(next.receipt),
				ready: String(next.ready),
				cancelled: String(next.cancelled),
			},
			{ method: 'POST' },
		)
	}

	return (
		<Card
			role="region"
			aria-label={_(t`Guest order messages`)}
			className="w-full"
		>
			<CardHeader>
				<CardTitle>
					<Trans>Guest order messages</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Sent to guests by email after an online order. Texts go only to
						guests who asked for them at checkout.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-6">
				{rows.map((row) => (
					<div key={row.key} className="flex flex-col gap-3">
						<label className="flex min-h-11 items-center justify-between gap-4">
							<span className="font-medium">{row.label}</span>
							<Switch
								checked={current[row.key]}
								disabled={!canEdit}
								aria-busy={fetcher.state !== 'idle' || undefined}
								aria-label={row.label}
								onCheckedChange={(checked) => save(row.key, checked)}
							/>
						</label>
						<div className="bg-muted/40 flex flex-col gap-1 rounded-md border p-3 text-sm">
							<p className="text-muted-foreground text-xs">
								<Trans>Preview</Trans>
							</p>
							<p className="font-medium">{row.subject}</p>
							{row.lines.map((line) => (
								<p key={line} className="text-muted-foreground">
									{line}
								</p>
							))}
						</div>
					</div>
				))}
				<p role="status" className="text-destructive text-sm empty:hidden">
					{failed ? _(t`That did not save. Try again.`) : ''}
				</p>
				{!canEdit ? (
					<p className="text-muted-foreground text-sm">
						<Trans>Only people who can change settings can edit these.</Trans>
					</p>
				) : null}
			</CardContent>
		</Card>
	)
}
