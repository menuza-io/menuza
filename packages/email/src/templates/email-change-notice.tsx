import { brand, getBrandTeam } from '@repo/config/brand'

import {
	EmailCard,
	EmailDetails,
	EmailEyebrow,
	EmailField,
	EmailHeading,
	EmailLayout,
	EmailLink,
	EmailNote,
	EmailParagraph,
} from '../components'

export interface EmailChangeNoticeEmailProps {
	userId: string
	firstName?: string
}

export default function EmailChangeNoticeEmail({
	userId,
	firstName = 'Developer',
}: EmailChangeNoticeEmailProps) {
	return (
		<EmailLayout preview={`Your ${brand.name} email has been changed`}>
			<EmailCard size="message">
				<EmailEyebrow>Security notice</EmailEyebrow>

				<EmailHeading>Email address changed, {firstName}</EmailHeading>

				<EmailParagraph>
					We're writing to let you know that your {brand.name} email address has
					been successfully changed. This is an important security notification.
				</EmailParagraph>

				<EmailParagraph className="mb-[32px]">
					If you made this change, you can safely ignore this email. Your
					account is secure and ready to use with your new email address.
				</EmailParagraph>

				<EmailDetails align="center">
					<EmailField
						align="center"
						label="Username"
						value={userId}
						className="mb-0"
					/>
				</EmailDetails>

				<EmailNote>
					If you did not authorize this change, contact our support team
					immediately to secure your account.
				</EmailNote>

				<EmailNote>
					<EmailLink href={`mailto:${brand.supportEmail}`}>
						Contact support
					</EmailLink>
					{' · '}
					<EmailLink href={`${brand.url}/security`}>Security center</EmailLink>
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

EmailChangeNoticeEmail.PreviewProps = {
	userId: 'user_123456789',
	firstName: 'Alex',
} as EmailChangeNoticeEmailProps
