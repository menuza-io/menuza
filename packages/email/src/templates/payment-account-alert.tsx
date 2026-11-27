import { brand, getBrandTeam } from '@repo/config/brand'

import {
	EmailButton,
	EmailCard,
	EmailEyebrow,
	EmailHeading,
	EmailLayout,
	EmailNote,
	EmailParagraph,
} from '../components'

export interface PaymentAccountAlertEmailProps {
	organizationName: string
	locationNames?: string[]
	state:
		'action_needed' | 'payouts_paused' | 'cannot_take_payments' | 'recovered'
	requirements?: string[]
	deadlineLabel?: string | null
	actionUrl: string
	isReminder?: boolean
}

export default function PaymentAccountAlertEmail({
	organizationName,
	locationNames = [],
	state,
	requirements = [],
	deadlineLabel = null,
	actionUrl,
	isReminder = false,
}: PaymentAccountAlertEmailProps) {
	const locationSummary =
		locationNames.length > 0
			? `${organizationName} (${locationNames.join(', ')})`
			: organizationName

	const heading =
		state === 'recovered'
			? `All set — payments are active for ${organizationName}`
			: state === 'cannot_take_payments'
				? `Action required: ${organizationName} cannot take payments`
				: state === 'payouts_paused'
					? `Action required: payouts are paused for ${organizationName}`
					: isReminder && deadlineLabel
						? `Reminder: payment account info due by ${deadlineLabel}`
						: `Action needed on your payment account`

	const preview =
		state === 'recovered'
			? `Your payment account for ${organizationName} is healthy and active.`
			: `Your payment provider needs action for ${locationSummary}.`

	return (
		<EmailLayout preview={preview} fallbackUrl={actionUrl}>
			<EmailCard>
				<EmailEyebrow align="left">Payments</EmailEyebrow>

				<EmailHeading align="left">{heading}</EmailHeading>

				{state === 'recovered' ? (
					<EmailParagraph align="left">
						All requirements for {locationSummary} have been resolved. Online
						payments and payouts are active again.
					</EmailParagraph>
				) : (
					<>
						<EmailParagraph align="left">
							{state === 'cannot_take_payments'
								? `Your payment provider has paused card payments for ${locationSummary} until required information is submitted.`
								: state === 'payouts_paused'
									? `Payouts to your bank account are paused for ${locationSummary} until required information is submitted.`
									: deadlineLabel
										? `Your payment provider needs additional information for ${locationSummary} by ${deadlineLabel} to avoid interruptions.`
										: `Your payment provider needs additional information for ${locationSummary}.`}
						</EmailParagraph>

						{requirements.length > 0 ? (
							<EmailParagraph align="left">
								<strong>What is needed:</strong>
								<br />
								{requirements.map((req, idx) => (
									<span key={`${idx}-${req}`}>
										• {req}
										{idx < requirements.length - 1 ? <br /> : null}
									</span>
								))}
							</EmailParagraph>
						) : null}

						<EmailButton href={actionUrl}>Update payment account</EmailButton>
					</>
				)}

				<EmailNote align="left" className="mb-0">
					For security, this email never includes bank account numbers or
					document contents.
					<br />
					{getBrandTeam()} · {brand.name}
				</EmailNote>
			</EmailCard>
		</EmailLayout>
	)
}
