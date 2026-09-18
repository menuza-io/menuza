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

export interface SignupEmailProps {
	onboardingUrl: string
	otp: string
	firstName?: string
}

export default function SignupEmail({
	onboardingUrl,
	otp,
	firstName = '',
}: SignupEmailProps) {
	const greeting = firstName ? `Welcome, ${firstName}!` : 'Welcome!'

	return (
		<EmailLayout
			preview={`Verify your email to get started with ${brand.name}`}
			fallbackUrl={onboardingUrl}
		>
			<EmailCard size="message">
				<EmailEyebrow>Verify your email</EmailEyebrow>

				<EmailHeading size="hero">{greeting}</EmailHeading>

				<EmailParagraph>
					Thanks for signing up for {brand.name}. Confirm your email to activate
					your account — then you can sign in and finish setup.
				</EmailParagraph>

				<EmailCode label="Your verification code">{otp}</EmailCode>

				<EmailNote className="mb-[32px]">
					Prefer one tap? Use the button below instead.
				</EmailNote>

				<EmailButton href={onboardingUrl}>Verify email</EmailButton>

				<EmailNote>
					This code expires in 10 minutes. If you didn't create a {brand.name}{' '}
					account, you can safely ignore this email.
				</EmailNote>

				<EmailNote className="mb-0">
					Glad you're here,
					<br />
					{getBrandTeam()}
				</EmailNote>
			</EmailCard>
		</EmailLayout>
	)
}

SignupEmail.PreviewProps = {
	onboardingUrl: 'https://example.com/onboarding/abc123',
	otp: '123456',
	firstName: 'Alex',
} as SignupEmailProps
