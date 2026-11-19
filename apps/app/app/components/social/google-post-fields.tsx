import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import {
	Field,
	FieldDescription,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Textarea } from '@repo/ui/textarea'
import {
	GOOGLE_BUTTON_TYPES,
	GOOGLE_COUPON_MAX,
	GOOGLE_TERMS_MAX,
	GOOGLE_TITLE_MAX,
	GOOGLE_TOPIC_TYPES,
	type GoogleButtonType,
	type GooglePostDetails,
	type GoogleTopicType,
} from '#app/utils/social/google-post.ts'

export type GooglePostValue = {
	topicType: GoogleTopicType
	details: GooglePostDetails
}

const TOPIC_LABELS: Record<GoogleTopicType, MessageDescriptor> = {
	STANDARD: msg`Update`,
	OFFER: msg`Offer`,
	EVENT: msg`Event`,
}

const BUTTON_LABELS: Record<GoogleButtonType | 'NONE', MessageDescriptor> = {
	NONE: msg`No button`,
	ORDER: msg`Order online`,
	BOOK: msg`Book`,
	LEARN_MORE: msg`Learn more`,
	CALL: msg`Call`,
}

/**
 * The Google-only part of the composer (#135): the post type and its fields.
 * The rules (`googlePostProblems`) are shared with the server; the problems
 * show under the preview.
 */
export function GooglePostFields({
	value,
	onChange,
}: {
	value: GooglePostValue
	onChange: (next: GooglePostValue) => void
}) {
	const { _ } = useLingui()
	const { details, topicType } = value
	const setDetails = (patch: Partial<GooglePostDetails>) =>
		onChange({ topicType, details: { ...details, ...patch } })
	const offer = details.offer ?? {
		title: '',
		startDate: '',
		endDate: '',
		couponCode: '',
		termsConditions: '',
		redeemUrl: '',
	}
	const event = details.event ?? {
		title: '',
		startDate: '',
		startTime: '',
		endDate: '',
		endTime: '',
	}
	const buttonType = details.button?.type ?? 'NONE'
	const buttonItems = [
		{ label: _(BUTTON_LABELS.NONE), value: 'NONE' },
		...GOOGLE_BUTTON_TYPES.map((type) => ({
			label: _(BUTTON_LABELS[type]),
			value: type,
		})),
	]

	return (
		<FieldSet>
			<FieldLegend>{_(msg`Google post`)}</FieldLegend>
			<div
				className="flex flex-wrap gap-2"
				role="group"
				aria-label={_(msg`Post type`)}
			>
				{GOOGLE_TOPIC_TYPES.map((type) => (
					<Button
						key={type}
						type="button"
						size="sm"
						variant={topicType === type ? 'default' : 'outline'}
						aria-pressed={topicType === type}
						onClick={() => onChange({ topicType: type, details })}
					>
						{_(TOPIC_LABELS[type])}
					</Button>
				))}
			</div>

			{topicType === 'OFFER' ? (
				<div className="grid gap-4 sm:grid-cols-2">
					<Field className="sm:col-span-2">
						<FieldLabel htmlFor="google-offer-title">
							{_(msg`Offer title`)}
						</FieldLabel>
						<Input
							id="google-offer-title"
							value={offer.title}
							maxLength={GOOGLE_TITLE_MAX + 20}
							onChange={(event) =>
								setDetails({ offer: { ...offer, title: event.target.value } })
							}
						/>
						<FieldDescription>
							{(() => {
								const used = [...offer.title].length
								return _(msg`${used} of ${GOOGLE_TITLE_MAX} characters`)
							})()}
						</FieldDescription>
					</Field>
					<Field>
						<FieldLabel htmlFor="google-offer-start">
							{_(msg`Starts`)}
						</FieldLabel>
						<Input
							id="google-offer-start"
							type="date"
							value={offer.startDate}
							onChange={(event) =>
								setDetails({
									offer: { ...offer, startDate: event.target.value },
								})
							}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor="google-offer-end">{_(msg`Ends`)}</FieldLabel>
						<Input
							id="google-offer-end"
							type="date"
							value={offer.endDate}
							onChange={(event) =>
								setDetails({
									offer: { ...offer, endDate: event.target.value },
								})
							}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor="google-offer-code">
							{_(msg`Coupon code`)}
						</FieldLabel>
						<Input
							id="google-offer-code"
							value={offer.couponCode}
							maxLength={GOOGLE_COUPON_MAX + 20}
							onChange={(event) =>
								setDetails({
									offer: { ...offer, couponCode: event.target.value },
								})
							}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor="google-offer-link">
							{_(msg`Redeem link`)}
						</FieldLabel>
						<Input
							id="google-offer-link"
							type="url"
							inputMode="url"
							dir="ltr"
							value={offer.redeemUrl}
							onChange={(event) =>
								setDetails({
									offer: { ...offer, redeemUrl: event.target.value },
								})
							}
						/>
					</Field>
					<Field className="sm:col-span-2">
						<FieldLabel htmlFor="google-offer-terms">
							{_(msg`Terms`)}
						</FieldLabel>
						<Textarea
							id="google-offer-terms"
							rows={3}
							value={offer.termsConditions}
							maxLength={GOOGLE_TERMS_MAX + 100}
							onChange={(event) =>
								setDetails({
									offer: { ...offer, termsConditions: event.target.value },
								})
							}
						/>
					</Field>
				</div>
			) : null}

			{topicType === 'EVENT' ? (
				<div className="grid gap-4 sm:grid-cols-2">
					<Field className="sm:col-span-2">
						<FieldLabel htmlFor="google-event-title">
							{_(msg`Event title`)}
						</FieldLabel>
						<Input
							id="google-event-title"
							value={event.title}
							maxLength={GOOGLE_TITLE_MAX + 20}
							onChange={(change) =>
								setDetails({ event: { ...event, title: change.target.value } })
							}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor="google-event-start">
							{_(msg`Starts`)}
						</FieldLabel>
						<div className="flex gap-2">
							<Input
								id="google-event-start"
								type="date"
								value={event.startDate}
								onChange={(change) =>
									setDetails({
										event: { ...event, startDate: change.target.value },
									})
								}
							/>
							<Input
								type="time"
								aria-label={_(msg`Start time`)}
								value={event.startTime}
								onChange={(change) =>
									setDetails({
										event: { ...event, startTime: change.target.value },
									})
								}
							/>
						</div>
					</Field>
					<Field>
						<FieldLabel htmlFor="google-event-end">{_(msg`Ends`)}</FieldLabel>
						<div className="flex gap-2">
							<Input
								id="google-event-end"
								type="date"
								value={event.endDate}
								onChange={(change) =>
									setDetails({
										event: { ...event, endDate: change.target.value },
									})
								}
							/>
							<Input
								type="time"
								aria-label={_(msg`End time`)}
								value={event.endTime}
								onChange={(change) =>
									setDetails({
										event: { ...event, endTime: change.target.value },
									})
								}
							/>
						</div>
					</Field>
				</div>
			) : null}

			<div className="grid gap-4 sm:grid-cols-2">
				<Field>
					<FieldLabel>{_(msg`Button`)}</FieldLabel>
					<Select
						value={buttonType}
						items={buttonItems}
						onValueChange={(next) => {
							if (!next || next === 'NONE') {
								const { button: _removed, ...rest } = details
								onChange({ topicType, details: rest })
								return
							}
							setDetails({
								button: {
									type: next as GoogleButtonType,
									url: details.button?.url,
								},
							})
						}}
					>
						<SelectTrigger>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{buttonItems.map((item) => (
								<SelectItem key={item.value} value={item.value}>
									{item.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
				{details.button && details.button.type !== 'CALL' ? (
					<Field>
						<FieldLabel htmlFor="google-button-url">
							{_(msg`Button link`)}
						</FieldLabel>
						<Input
							id="google-button-url"
							type="url"
							inputMode="url"
							dir="ltr"
							value={details.button.url ?? ''}
							onChange={(change) =>
								setDetails({
									button: {
										type: details.button!.type,
										url: change.target.value,
									},
								})
							}
						/>
					</Field>
				) : null}
			</div>
			<FieldDescription>
				{_(
					msg`Google refuses phone numbers in the text. Use the Call button instead.`,
				)}
			</FieldDescription>
		</FieldSet>
	)
}
