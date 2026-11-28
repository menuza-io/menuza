import {
	EmailButton,
	EmailCard,
	EmailEyebrow,
	EmailHeading,
	EmailLayout,
	EmailLink,
	EmailNote,
	EmailParagraph,
} from '../components'

export interface SetupReminderEmailProps {
	/** `en` or `ar`; Arabic is laid out right to left. */
	lang: string
	dir: 'ltr' | 'rtl'
	preview: string
	eyebrow: string
	/** The one next step in plain words, with its time. */
	heading: string
	intro: string
	/** "4 of 7 done". */
	progress: string
	actionLabel: string
	/** The exact screen of the step. */
	actionUrl: string
	unsubscribeLabel: string
	unsubscribeUrl: string
	footer: string
}

/**
 * The reminder to finish setting up (#271): one step, how long it takes, the
 * progress so far and one button. Every sentence is written by the caller (in
 * the owner's language), so the template carries no copy of its own. It names no
 * guest, person or figure.
 */
export default function SetupReminderEmail({
	lang,
	dir,
	preview,
	eyebrow,
	heading,
	intro,
	progress,
	actionLabel,
	actionUrl,
	unsubscribeLabel,
	unsubscribeUrl,
	footer,
}: SetupReminderEmailProps) {
	return (
		<EmailLayout preview={preview} lang={lang} dir={dir}>
			<EmailCard size="message">
				<EmailEyebrow>{eyebrow}</EmailEyebrow>

				<EmailHeading>{heading}</EmailHeading>

				<EmailParagraph>{intro}</EmailParagraph>

				<EmailNote>{progress}</EmailNote>

				<EmailButton href={actionUrl}>{actionLabel}</EmailButton>

				<EmailNote className="mb-0">
					{footer}{' '}
					<EmailLink href={unsubscribeUrl}>{unsubscribeLabel}</EmailLink>
				</EmailNote>
			</EmailCard>
		</EmailLayout>
	)
}

SetupReminderEmail.PreviewProps = {
	lang: 'en',
	dir: 'ltr',
	preview: 'Add your address and opening hours, about 3 minutes.',
	eyebrow: 'Setting up your restaurant',
	heading: 'Add your address and opening hours, about 3 minutes',
	intro:
		'You started setting up Acme Grill and one step is next. After it you are closer to your first order.',
	progress: '4 of 7 done',
	actionLabel: 'Continue setup',
	actionUrl: 'https://example.com/acme/settings/locations/loc_1',
	unsubscribeLabel: 'Turn off these reminders',
	unsubscribeUrl: 'https://example.com/resources/report-unsubscribe?token=x',
	footer: 'We send up to three short reminders, then stop.',
} as SetupReminderEmailProps
