import { Body, Head, Html, Preview } from '@react-email/components'
import { type EmailBlock } from '@repo/common/email-blocks'
import { type EmailTheme } from '@repo/common/email-theme'

import { EmailBody, type EmailSocialLink } from './email-body.tsx'

export type EmailDocumentProps = {
	blocks: EmailBlock[]
	theme: EmailTheme
	socials?: EmailSocialLink[]
	/** Inbox preview text; falls back to the subject when provided by the caller. */
	previewText?: string
}

export function EmailDocument({
	blocks,
	theme,
	socials,
	previewText,
}: EmailDocumentProps) {
	return (
		<Html lang="en" dir="ltr">
			<Head />
			{previewText ? <Preview>{previewText}</Preview> : null}
			<Body
				style={{
					margin: 0,
					padding: 0,
					backgroundColor: theme.background,
					fontFamily: theme.bodyFont,
				}}
			>
				<EmailBody blocks={blocks} theme={theme} socials={socials} />
			</Body>
		</Html>
	)
}
