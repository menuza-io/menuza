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

export interface EmailChangeEmailProps {
	verifyUrl: string
	otp: string
	firstName?: string
}

export default function EmailChangeEmail({
	verifyUrl,
	otp,
	firstName = 'Developer',
}: EmailChangeEmailProps) {
	return (
		<EmailLayout
			preview={`Verify your new ${brand.name} email address`}
			fallbackUrl={verifyUrl}
		>
			<EmailCard size="message">
				<EmailEyebrow>Account security</EmailEyebrow>

				<EmailHeading>Verify your new email, {firstName}</EmailHeading>

				<EmailParagraph>
					We need to verify your new email address to complete the change to
					your {brand.name} account. This helps keep your account secure.
				</EmailParagraph>

				<EmailCode label="Here's your verification code:">{otp}</EmailCode>

				<EmailButton href={verifyUrl}>Verify Email</EmailButton>

				<EmailNote>
					If you didn't request this email change, please contact our support
					team immediately to secure your account.
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

EmailChangeEmail.PreviewProps = {
	verifyUrl: 'https://example.com/verify/abc123',
	otp: '123456',
	firstName: 'Alex',
} as EmailChangeEmailProps
