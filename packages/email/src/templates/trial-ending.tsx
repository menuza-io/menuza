import { brand, getBrandTeam } from '@repo/config/brand'

import {
	EmailButton,
	EmailCard,
	EmailEyebrow,
	EmailHeading,
	EmailLayout,
	EmailNote,
	EmailParagraph,
	EmailStep,
	EmailSteps,
} from '../components'

export interface TrialEndingEmailProps {
	portalUrl: string
	userName?: string
	daysRemaining?: number
}

export default function TrialEndingEmail({
	portalUrl,
	userName = 'Developer',
	daysRemaining = 3,
}: TrialEndingEmailProps) {
	const days = daysRemaining === 1 ? 'day' : 'days'

	return (
		<EmailLayout
			preview={`Your ${brand.name} trial ends in ${daysRemaining.toString()} ${days}`}
			fallbackUrl={portalUrl}
		>
			<EmailCard>
				<EmailEyebrow align="left">Subscription</EmailEyebrow>

				<EmailHeading align="left">
					Your trial ends soon, {userName}
				</EmailHeading>

				<EmailParagraph align="left">
					Your {brand.name} trial is ending in {daysRemaining} {days}. We hope
					you've been enjoying {brand.name}.
				</EmailParagraph>

				<EmailParagraph align="left" className="mb-[32px]">
					To continue using {brand.name} without interruption and keep all your
					data and settings, please upgrade your account:
				</EmailParagraph>

				<EmailSteps align="left">
					<EmailStep n={1} title="Keep all your data and settings" />
					<EmailStep n={2} title="Continue collaborating with your team" />
					<EmailStep
						n={3}
						title="Access premium features and integrations"
						last
					/>
				</EmailSteps>

				<EmailButton href={portalUrl}>Upgrade Now</EmailButton>

				<EmailNote align="left">
					Questions about pricing or need help choosing the right plan? Our
					support team is here to help you make the most of {brand.name}.
				</EmailNote>

				<EmailNote align="left" className="mb-0">
					Thank you for trying {brand.name}!
					<br />
					{getBrandTeam()}
				</EmailNote>
			</EmailCard>
		</EmailLayout>
	)
}

TrialEndingEmail.PreviewProps = {
	portalUrl: 'https://billing.example.com/p/session/test_123',
	userName: 'John Doe',
	daysRemaining: 3,
} as TrialEndingEmailProps
