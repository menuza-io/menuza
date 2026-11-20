import {
	EmailCard,
	EmailCode,
	EmailEyebrow,
	EmailHeading,
	EmailLayout,
	EmailNote,
	EmailParagraph,
} from '../components'

export interface ReplyToVerificationEmailProps {
	organizationName: string
	code: string
	minutesValid: number
}

/**
 * The code that proves an operator controls the address guests will reply to
 * (#103). Sent to the address itself; the reply-to is used only after the code
 * is entered in Settings.
 */
export default function ReplyToVerificationEmail({
	organizationName,
	code,
	minutesValid,
}: ReplyToVerificationEmailProps) {
	return (
		<EmailLayout preview={`Your code: ${code}`}>
			<EmailCard size="message">
				<EmailEyebrow>Email sending</EmailEyebrow>
				<EmailHeading>Confirm this reply-to address</EmailHeading>
				<EmailParagraph>
					Someone set up {organizationName} to send guest email with this
					address as the reply-to. Enter the code below in Settings, Email
					sending to confirm it.
				</EmailParagraph>
				<EmailCode label="Your code">{code}</EmailCode>
				<EmailNote>
					The code works for {minutesValid} minutes. If this was not you, ignore
					this message and nothing changes.
				</EmailNote>
			</EmailCard>
		</EmailLayout>
	)
}

ReplyToVerificationEmail.PreviewProps = {
	organizationName: 'Al Bait',
	code: '482913',
	minutesValid: 15,
} satisfies ReplyToVerificationEmailProps
