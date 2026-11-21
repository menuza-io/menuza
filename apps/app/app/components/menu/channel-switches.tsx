import { type MessageDescriptor } from '@lingui/core'
import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { MENU_CHANNELS, type MenuChannel } from '@repo/common/menu-channels'
import { Label } from '@repo/ui/label'
import { Switch } from '@repo/ui/switch'

export const MENU_CHANNEL_MESSAGES: Record<MenuChannel, MessageDescriptor> = {
	web: msg`Online website`,
	qr: msg`QR menu & table ordering`,
	pos: msg`Station till (POS)`,
	app: msg`Customer mobile app`,
}

export const MENU_CHANNEL_SHORT_MESSAGES: Record<
	MenuChannel,
	MessageDescriptor
> = {
	web: msg`Web`,
	qr: msg`QR`,
	pos: msg`POS`,
	app: msg`App`,
}

/**
 * Ordering channels (#220): one switch per channel (`web`, `qr`, `pos`, `app`).
 * When `allowedChannels` is passed (location override), channels turned off on
 * the parent entity are disabled so an override can only narrow, never widen.
 */
export function ChannelSwitches({
	idPrefix,
	channels,
	onChange,
	allowedChannels,
	compact = false,
}: {
	idPrefix: string
	channels: readonly MenuChannel[]
	onChange: (channels: MenuChannel[]) => void
	allowedChannels?: readonly MenuChannel[]
	compact?: boolean
}) {
	const { _ } = useLingui()
	const allowedSet = allowedChannels ? new Set(allowedChannels) : null
	const toggle = (channel: MenuChannel, on: boolean) => {
		if (allowedSet && !allowedSet.has(channel)) return
		const next = new Set(channels)
		if (on) next.add(channel)
		else next.delete(channel)
		onChange(
			MENU_CHANNELS.filter(
				(value) => next.has(value) && (!allowedSet || allowedSet.has(value)),
			),
		)
	}

	if (compact) {
		return (
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
				{MENU_CHANNELS.map((channel) => {
					const allowed = !allowedSet || allowedSet.has(channel)
					const checked = allowed && channels.includes(channel)
					return (
						<div key={channel} className="flex items-center gap-1.5">
							<Switch
								id={`${idPrefix}-${channel}`}
								checked={checked}
								disabled={!allowed}
								onCheckedChange={(on) => toggle(channel, on)}
							/>
							<Label
								htmlFor={`${idPrefix}-${channel}`}
								className={
									allowed
										? 'cursor-pointer text-xs font-normal'
										: 'text-muted-foreground text-xs font-normal'
								}
							>
								{_(MENU_CHANNEL_SHORT_MESSAGES[channel])}
							</Label>
						</div>
					)
				})}
			</div>
		)
	}

	return (
		<div className="flex flex-col gap-2">
			<div className="divide-border/60 bg-background divide-y overflow-hidden rounded-md border">
				{MENU_CHANNELS.map((channel) => {
					const allowed = !allowedSet || allowedSet.has(channel)
					const checked = allowed && channels.includes(channel)
					return (
						<div
							key={channel}
							className="flex items-center justify-between gap-3 px-3 py-2.5"
						>
							<Label
								htmlFor={`${idPrefix}-${channel}`}
								className={
									allowed
										? 'min-w-0 flex-1 cursor-pointer font-normal'
										: 'text-muted-foreground min-w-0 flex-1 font-normal'
								}
							>
								<span className="text-sm font-medium">
									{_(MENU_CHANNEL_MESSAGES[channel])}
								</span>
							</Label>
							<Switch
								id={`${idPrefix}-${channel}`}
								checked={checked}
								disabled={!allowed}
								onCheckedChange={(on) => toggle(channel, on)}
								className="shrink-0"
							/>
						</div>
					)
				})}
			</div>
			{channels.length === 0 ? (
				<p className="text-muted-foreground text-xs">
					<Trans>Off on all channels until at least one is switched on.</Trans>
				</p>
			) : null}
		</div>
	)
}
