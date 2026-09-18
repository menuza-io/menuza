import {
	EmailButton,
	EmailCard,
	EmailEyebrow,
	EmailHeading,
	EmailLayout,
	EmailParagraph,
	EmailQuote,
} from '../components'

export interface CommentEmailProps {
	noteUrl: string
	noteTitle: string
	commenterName: string
	commentContent: string
}

export default function CommentEmail({
	noteUrl,
	noteTitle,
	commenterName,
	commentContent,
}: CommentEmailProps) {
	return (
		<EmailLayout preview={`${commenterName} commented on "${noteTitle}"`}>
			<EmailCard size="message">
				<EmailEyebrow>Comment</EmailEyebrow>

				<EmailHeading>New comment</EmailHeading>

				<EmailParagraph>
					<strong className="text-foreground font-semibold">
						{commenterName}
					</strong>{' '}
					left a new comment on "{noteTitle}".
				</EmailParagraph>

				<EmailQuote>"{commentContent}"</EmailQuote>

				<EmailButton href={noteUrl} className="mb-0">
					View Comment
				</EmailButton>
			</EmailCard>
		</EmailLayout>
	)
}

CommentEmail.PreviewProps = {
	noteUrl: 'https://example.com/notes/abc123',
	noteTitle: 'Project Alpha Planning',
	commenterName: 'Jane Smith',
	commentContent: 'This looks like a solid plan. Let us move forward.',
} as CommentEmailProps
