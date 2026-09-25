import {
	EmailButton,
	EmailCard,
	EmailEyebrow,
	EmailHeading,
	EmailLayout,
	EmailParagraph,
	EmailQuote,
} from '../components'

export interface MentionEmailProps {
	noteUrl: string
	noteTitle: string
	commenterName: string
	commentContent: string
}

export default function MentionEmail({
	noteUrl,
	noteTitle,
	commenterName,
	commentContent,
}: MentionEmailProps) {
	return (
		<EmailLayout
			preview={`${commenterName} mentioned you in a comment on "${noteTitle}"`}
		>
			<EmailCard size="message">
				<EmailEyebrow>Mention</EmailEyebrow>

				<EmailHeading>You were mentioned!</EmailHeading>

				<EmailParagraph>
					<strong className="text-foreground">
						{commenterName}
					</strong>{' '}
					mentioned you in a comment on "{noteTitle}".
				</EmailParagraph>

				<EmailQuote>"{commentContent}"</EmailQuote>

				<EmailButton href={noteUrl} className="mb-0">
					View Comment
				</EmailButton>
			</EmailCard>
		</EmailLayout>
	)
}

MentionEmail.PreviewProps = {
	noteUrl: 'https://example.com/notes/abc123',
	noteTitle: 'Project Alpha Planning',
	commenterName: 'Jane Smith',
	commentContent: 'Hey @alex, what do you think about this proposal?',
} as MentionEmailProps
