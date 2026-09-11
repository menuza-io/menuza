import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { Textarea } from '@repo/ui/textarea'
import { Icon } from '@repo/ui/icon'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useCampaignLabels } from '../i18n/campaign-labels.ts'
import { type CampaignChannel } from '../types/campaign.ts'

export interface CampaignFormProps {
	error?: string | null
	isSubmitting?: boolean
	cancelTo?: string
	showSmsProBadge?: boolean
	audienceField?: ReactNode
	/** Replaces the message textarea when the email channel is selected. */
	emailDesigner?: ReactNode
	submitLabel?: string
	submittingLabel?: string
}

export function CampaignForm({
	error,
	isSubmitting = false,
	cancelTo,
	showSmsProBadge = true,
	audienceField,
	emailDesigner,
	submitLabel,
	submittingLabel,
}: CampaignFormProps) {
	const { _ } = useLingui()
	const { channelLabel } = useCampaignLabels()
	const [channel, setChannel] = useState<CampaignChannel>('email')

	const channels: Array<{
		value: CampaignChannel
		icon: 'mail' | 'smartphone'
	}> = [
		{ value: 'email', icon: 'mail' },
		{ value: 'sms', icon: 'smartphone' },
	]

	const resolvedSubmitLabel = submitLabel ?? _(msg`Send now`)
	const resolvedSubmittingLabel = submittingLabel ?? _(msg`Sending...`)

	return (
		<div className="space-y-6">
			{error ? <p className="text-destructive text-sm">{error}</p> : null}

			<div className="space-y-2">
				<Label>{_(msg`Channel`)}</Label>
				<input type="hidden" name="channel" value={channel} />
				<div className="inline-flex rounded-lg border p-1">
					{channels.map((option) => (
						<button
							key={option.value}
							type="button"
							onClick={() => setChannel(option.value)}
							className={cn(
								'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
								channel === option.value
									? 'bg-muted text-foreground'
									: 'text-muted-foreground hover:text-foreground',
							)}
						>
							<Icon name={option.icon} className="size-4" />
							<span>{channelLabel(option.value)}</span>
							{showSmsProBadge && option.value === 'sms' ? (
								<span className="text-muted-foreground text-[10px] font-normal tracking-wide uppercase">
									{_(msg`Pro`)}
								</span>
							) : null}
						</button>
					))}
				</div>
			</div>

			<div className="space-y-5 rounded-lg border p-5">
				{audienceField}

				<div className="space-y-2">
					<Label htmlFor="name">{_(msg`Campaign name`)}</Label>
					<Input
						id="name"
						name="name"
						placeholder={_(msg`Summer promo`)}
						required
					/>
				</div>

				{channel === 'email' ? (
					<div className="space-y-2">
						<Label htmlFor="subject">{_(msg`Subject`)}</Label>
						<Input
							id="subject"
							name="subject"
							placeholder={_(msg`Check out our new summer menu`)}
							required
						/>
					</div>
				) : null}

				{channel === 'email' && emailDesigner ? (
					<div className="space-y-2">
						<Label>{_(msg`Email design`)}</Label>
						{emailDesigner}
					</div>
				) : (
					<div className="space-y-2">
						<div className="flex items-center justify-between gap-4">
							<Label htmlFor="content">{_(msg`Message`)}</Label>
							<span className="text-muted-foreground text-xs">
								{'{{name}}'} {_(msg`supported`)}
							</span>
						</div>
						<Textarea
							id="content"
							name="content"
							placeholder={
								channel === 'email'
									? _(msg`Write your email. Use {{name}} to personalize.`)
									: _(msg`Write your text message. Max 160 characters.`)
							}
							className="min-h-[180px] resize-y"
							required
						/>
					</div>
				)}
			</div>

			<div className="flex items-center justify-between gap-3">
				{cancelTo ? (
					<Button
						type="button"
						variant="ghost"
						render={<Link to={cancelTo} />}
						disabled={isSubmitting}
					>
						{_(msg`Cancel`)}
					</Button>
				) : (
					<span />
				)}
				<Button type="submit" disabled={isSubmitting} className="gap-2">
					{isSubmitting ? (
						<>
							<Icon name="loader" className="size-4 animate-spin" />
							{resolvedSubmittingLabel}
						</>
					) : (
						<>
							<Icon name="send" className="size-4" />
							{resolvedSubmitLabel}
						</>
					)}
				</Button>
			</div>
		</div>
	)
}
