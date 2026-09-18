import { brand, getBrandTeam } from '@repo/config/brand'

import {
	EmailButton,
	EmailCard,
	EmailCode,
	EmailEyebrow,
	EmailHeading,
	EmailLayout,
	EmailNote,
	EmailParagraph,
} from '../components'

export interface ForgotPasswordEmailProps {
	onboardingUrl: string
	otp: string
	firstName?: string
}

export default function ForgotPasswordEmail({
	onboardingUrl,
	otp,
	firstName = 'Developer',
}: ForgotPasswordEmailProps) {
	return (
		<EmailLayout
			preview={`Reset your ${brand.name} password`}
			fallbackUrl={onboardingUrl}
		>
			<EmailCard size="message">
				<EmailEyebrow>Account security</EmailEyebrow>

				<EmailHeading>Reset your password, {firstName}</EmailHeading>

				<EmailParagraph>
					We received a request to reset your {brand.name} password. If you
					didn't make this request, you can safely ignore this email.
				</EmailParagraph>

				<EmailCode label="Here's your verification code:">{otp}</EmailCode>

				<EmailButton href={onboardingUrl}>Reset Password</EmailButton>

				<EmailNote>
					For security reasons, this link will expire in 10 minutes. If you need
					help, our support team is here to assist you.
				</EmailNote>

				<EmailNote className="mb-0">
					Stay secure!
					<br />
					{getBrandTeam()}
				</EmailNote>
			</EmailCard>
		</EmailLayout>
	)
}

ForgotPasswordEmail.PreviewProps = {
	onboardingUrl: 'https://example.com/verify/abc123',
	otp: '123456',
	firstName: 'Alex',
} as ForgotPasswordEmailProps
