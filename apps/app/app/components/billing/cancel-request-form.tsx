import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	CANCEL_REASONS,
	CANCEL_NOTE_MAX,
	type CancelReason,
	type CancelRequestKind,
} from '@repo/common/cancel-request'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	ChoiceCard,
	ChoiceCardContent,
	ChoiceCardDescription,
	ChoiceCardTitle,
} from '@repo/ui/choice-card'
import { Icon } from '@repo/ui/icon'
import { Label } from '@repo/ui/label'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { Textarea } from '@repo/ui/textarea'
import { useState } from 'react'
import { Form, Link } from 'react-router'
import {
	CANCEL_ERROR_TEXT,
	CANCEL_KIND_TEXT,
	CANCEL_REASON_TEXT,
	CANCEL_SUB_REASON_TEXT,
} from '#app/utils/billing/cancel-request-labels.ts'
import { type CancelRequestContext } from '#app/utils/billing/cancel-request.ts'

export type CancelFormLinks = Array<{ label: string; href: string }>

/**
 * The self-serve cancel or downgrade request (#379). It is a request: nothing
 * is cancelled when it is sent, and nothing happens before the cutoff date the
 * page states above the button. Retention offer and data exports come first.
 */
export function CancelRequestForm({
	context,
	downloads,
	billingHref,
	error,
}: {
	context: CancelRequestContext
	downloads: CancelFormLinks
	billingHref: string
	error: string | null
}) {
	const { _, i18n } = useLingui()
	const kinds: CancelRequestKind[] = [
		'cancel_locations',
		'cancel_organization',
		...(context.downgradeTo ? (['downgrade'] as const) : []),
	]
	const [kind, setKind] = useState<CancelRequestKind | ''>('')
	const [reason, setReason] = useState<CancelReason | ''>('')
	const [subReason, setSubReason] = useState('')
	const [locationIds, setLocationIds] = useState<string[]>([])
	const [confirmed, setConfirmed] = useState(false)
	const cutoff = context.cutoff
		? new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'long' }).format(
				new Date(context.cutoff),
			)
		: null
	const subReasons = reason ? CANCEL_REASONS[reason] : []
	const ready =
		kind !== '' &&
		reason !== '' &&
		confirmed &&
		cutoff !== null &&
		(kind !== 'cancel_locations' || locationIds.length > 0)

	if (context.open) {
		return (
			<Alert data-testid="cancel-request-open">
				<Icon name="info" />
				<AlertTitle>
					<Trans>You already have a request open</Trans>
				</AlertTitle>
				<AlertDescription>
					<Trans>
						Withdraw it on the billing page if you want to send a new one.
					</Trans>{' '}
					<Link to={billingHref} className="underline underline-offset-2">
						<Trans>Back to billing</Trans>
					</Link>
				</AlertDescription>
			</Alert>
		)
	}

	return (
		<Form
			method="post"
			className="flex flex-col gap-6"
			data-testid="cancel-form"
		>
			<input type="hidden" name="intent" value="request" />
			<input type="hidden" name="kind" value={kind} />
			<input type="hidden" name="reason" value={reason} />
			<input type="hidden" name="subReason" value={subReason} />
			{kind === 'downgrade' && context.downgradeTo ? (
				<input type="hidden" name="targetPlan" value={context.downgradeTo} />
			) : null}
			{kind === 'cancel_locations'
				? locationIds.map((id) => (
						<input key={id} type="hidden" name="locationIds" value={id} />
					))
				: null}

			{error ? (
				<Alert variant="destructive" data-testid="cancel-error">
					<Icon name="alert-triangle" />
					<AlertTitle>
						<Trans>We could not send the request</Trans>
					</AlertTitle>
					<AlertDescription>
						{CANCEL_ERROR_TEXT[error] ? _(CANCEL_ERROR_TEXT[error]) : error}
					</AlertDescription>
				</Alert>
			) : null}

			<fieldset className="flex flex-col gap-2">
				<legend className="mb-1 text-sm font-medium">
					<Trans>What would you like to do?</Trans>
				</legend>
				<RadioGroup
					value={kind}
					onValueChange={(value) => setKind(value as CancelRequestKind)}
				>
					{kinds.map((option) => (
						<ChoiceCard key={option}>
							<RadioGroupItem value={option} />
							<ChoiceCardContent>
								<ChoiceCardTitle>
									{_(CANCEL_KIND_TEXT[option].title)}
								</ChoiceCardTitle>
								<ChoiceCardDescription>
									{_(CANCEL_KIND_TEXT[option].description)}
								</ChoiceCardDescription>
							</ChoiceCardContent>
						</ChoiceCard>
					))}
				</RadioGroup>
			</fieldset>

			{kind === 'cancel_locations' ? (
				<fieldset className="flex flex-col gap-2">
					<legend className="mb-1 text-sm font-medium">
						<Trans>Which locations?</Trans>
					</legend>
					{context.locations.map((location) => (
						<ChoiceCard key={location.id}>
							<Checkbox
								checked={locationIds.includes(location.id)}
								onCheckedChange={(checked) =>
									setLocationIds((current) =>
										checked
											? [...current, location.id]
											: current.filter((id) => id !== location.id),
									)
								}
							/>
							<ChoiceCardContent>
								<ChoiceCardTitle>{location.name}</ChoiceCardTitle>
							</ChoiceCardContent>
						</ChoiceCard>
					))}
				</fieldset>
			) : null}

			<fieldset className="flex flex-col gap-2">
				<legend className="mb-1 text-sm font-medium">
					<Trans>Why?</Trans>
				</legend>
				<RadioGroup
					value={reason}
					onValueChange={(value) => {
						setReason(value as CancelReason)
						setSubReason('')
					}}
				>
					{(Object.keys(CANCEL_REASONS) as CancelReason[]).map((option) => (
						<ChoiceCard key={option}>
							<RadioGroupItem value={option} />
							<ChoiceCardContent>
								<ChoiceCardTitle>
									{_(CANCEL_REASON_TEXT[option])}
								</ChoiceCardTitle>
							</ChoiceCardContent>
						</ChoiceCard>
					))}
				</RadioGroup>
			</fieldset>

			{subReasons.length > 0 ? (
				<fieldset className="flex flex-col gap-2">
					<legend className="mb-1 text-sm font-medium">
						<Trans>Can you tell us more?</Trans>
					</legend>
					<RadioGroup value={subReason} onValueChange={setSubReason}>
						{subReasons.map((option) => (
							<ChoiceCard key={option}>
								<RadioGroupItem value={option} />
								<ChoiceCardContent>
									<ChoiceCardTitle>
										{CANCEL_SUB_REASON_TEXT[option]
											? _(CANCEL_SUB_REASON_TEXT[option])
											: option}
									</ChoiceCardTitle>
								</ChoiceCardContent>
							</ChoiceCard>
						))}
					</RadioGroup>
				</fieldset>
			) : null}

			<div className="flex flex-col gap-1.5">
				<Label htmlFor="cancel-note">
					<Trans>Anything else we should know? (optional)</Trans>
				</Label>
				<Textarea
					id="cancel-note"
					name="note"
					maxLength={CANCEL_NOTE_MAX}
					rows={3}
				/>
			</div>

			{context.retentionOffer ? (
				<Alert data-testid="retention-offer">
					<Icon name="sparkles" />
					<AlertTitle>
						<Trans>Before you go</Trans>
					</AlertTitle>
					<AlertDescription>{context.retentionOffer}</AlertDescription>
				</Alert>
			) : null}

			<div className="flex flex-col gap-2" data-testid="cancel-exports">
				<p className="text-sm font-medium">
					<Trans>Take your data with you first</Trans>
				</p>
				<p className="text-muted-foreground text-sm">
					<Trans>
						Download what you may want to keep. Nothing is deleted when you send
						this request.
					</Trans>
				</p>
				<ul className="flex flex-col gap-1 text-sm">
					{downloads.map((link) => (
						<li key={link.href}>
							<Link to={link.href} className="underline underline-offset-2">
								{link.label}
							</Link>
						</li>
					))}
				</ul>
			</div>

			<div className="bg-muted/40 flex flex-col gap-3 rounded-lg border p-4">
				<p className="text-sm font-medium" data-testid="cancel-cutoff">
					{cutoff ? (
						<Trans>
							This takes effect on {cutoff}, the end of your billing period.
							Until then everything keeps working and you are not charged
							anything extra.
						</Trans>
					) : (
						<Trans>
							We could not read your billing date right now, so we cannot send
							the request. Try again in a moment.
						</Trans>
					)}
				</p>
				<p className="text-muted-foreground text-sm">
					<Trans>
						Sending this request cancels nothing today. Menuza support will
						follow up, and you can withdraw the request any time before then.
					</Trans>
				</p>
				<div className="flex items-start gap-2">
					<Checkbox
						id="cancel-confirm"
						name="confirm"
						value="true"
						checked={confirmed}
						onCheckedChange={(checked) => setConfirmed(checked === true)}
					/>
					<Label htmlFor="cancel-confirm" className="text-sm leading-snug">
						<Trans>I understand, send the request</Trans>
					</Label>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button type="submit" variant="destructive" disabled={!ready}>
						<Trans>Send request</Trans>
					</Button>
					<Button variant="ghost" render={<Link to={billingHref} />}>
						<Trans>Back</Trans>
					</Button>
				</div>
			</div>
			<span className="sr-only">{_(msg`Cancel or downgrade request`)}</span>
		</Form>
	)
}
