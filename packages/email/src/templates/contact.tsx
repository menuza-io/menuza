import { brand } from '@repo/config/brand'

import {
	EmailCard,
	EmailDetails,
	EmailEyebrow,
	EmailField,
	EmailHeading,
	EmailLayout,
	EmailLink,
	EmailParagraph,
} from '../components'

export interface ContactTemplateProps {
	readonly name: string
	readonly email: string
	readonly message: string
}

export const ContactTemplate = ({
	name,
	email,
	message,
}: ContactTemplateProps) => (
	<EmailLayout preview={`New contact message from ${name}`}>
		<EmailCard>
			<EmailEyebrow align="left">Contact form</EmailEyebrow>

			<EmailHeading align="left">New contact message</EmailHeading>

			<EmailParagraph align="left">
				You've received a new contact message through {brand.name}. Here are the
				details:
			</EmailParagraph>

			<EmailDetails align="left" className="mb-0">
				<EmailField label="From" value={name} />
				<EmailField
					label="Email"
					value={<EmailLink href={`mailto:${email}`}>{email}</EmailLink>}
				/>
				<EmailField label="Message" value={message} className="mb-[24px]" />

				<EmailParagraph align="left" className="mb-0">
					You can reply directly to this email address:{' '}
					<EmailLink href={`mailto:${email}`}>{email}</EmailLink>
				</EmailParagraph>
			</EmailDetails>
		</EmailCard>
	</EmailLayout>
)

ContactTemplate.PreviewProps = {
	name: 'Jane Smith',
	email: 'jane.smith@example.com',
	message: "I'm interested in your services.",
}

export default ContactTemplate
