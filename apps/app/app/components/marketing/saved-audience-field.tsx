import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Label } from '@repo/ui/label'
import { Link } from 'react-router'

/**
 * "Send to" on a broadcast (#98): everyone subscribed, or one saved audience.
 * A saved audience only narrows the guests who agreed to hear from you: its
 * members are worked out when the send starts, never saved with the broadcast.
 */
export function SavedAudienceField({
	options,
	defaultValue,
	orgSlug,
}: {
	options: Array<{ id: string; name: string }>
	defaultValue?: string | null
	orgSlug: string
}) {
	const { _ } = useLingui()
	return (
		<div className="space-y-2">
			<Label htmlFor="audienceId">
				<Trans>Send to</Trans>
			</Label>
			<select
				id="audienceId"
				name="audienceId"
				defaultValue={defaultValue ?? ''}
				className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm sm:max-w-xs"
			>
				<option value="">{_(msg`All subscribers`)}</option>
				{options.map((audience) => (
					<option key={audience.id} value={audience.id}>
						{audience.name}
					</option>
				))}
			</select>
			<p className="text-muted-foreground text-xs">
				<Trans>
					Only guests who agreed to hear from you are included.{' '}
					<Link
						to={`/${orgSlug}/marketing/audiences`}
						className="underline underline-offset-2"
					>
						Manage audiences
					</Link>
				</Trans>
			</p>
		</div>
	)
}
