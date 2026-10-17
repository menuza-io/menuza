import { useLingui } from '@lingui/react/macro'
import { Badge } from '@repo/ui/badge'
import { CHANNEL_LABELS, enumLabel } from '#app/utils/reservations/labels.ts'

/** Where a booking came from (online, mobile app, voice agent, phone, ...). */
export function ChannelBadge({
	channel,
	testId,
}: {
	channel: string | null | undefined
	testId?: string
}) {
	const { i18n } = useLingui()
	if (!channel) return null
	return (
		<Badge variant="outline" data-testid={testId}>
			{enumLabel((d) => i18n._(d), CHANNEL_LABELS, channel)}
		</Badge>
	)
}
