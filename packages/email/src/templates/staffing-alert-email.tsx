import {
	EmailButton,
	EmailCard,
	EmailEyebrow,
	EmailHeading,
	EmailLayout,
	EmailNote,
	EmailParagraph,
} from '../components'

export interface StaffingAlertEmailProps {
	/** What the alert is about, for example "Attendance". */
	eyebrow: string
	headline: string
	/** One or two plain sentences. Counts and a place, never a person. */
	detail: string
	actionLabel: string
	actionUrl: string
	/** Where to change this, shown small under the button. */
	settingsNote?: string
}

/**
 * A manager alert about the time clock. By design it carries no staff name, time
 * or pay: tenant-api only tells the App that something needs attention, and
 * the details are read in the app after signing in.
 */
export default function StaffingAlertEmail({
	eyebrow,
	headline,
	detail,
	actionLabel,
	actionUrl,
	settingsNote,
}: StaffingAlertEmailProps) {
	return (
		<EmailLayout preview={headline}>
			<EmailCard size="message">
				<EmailEyebrow>{eyebrow}</EmailEyebrow>

				<EmailHeading>{headline}</EmailHeading>

				<EmailParagraph>{detail}</EmailParagraph>

				<EmailButton href={actionUrl} className="mb-0">
					{actionLabel}
				</EmailButton>

				{settingsNote ? <EmailNote>{settingsNote}</EmailNote> : null}
			</EmailCard>
		</EmailLayout>
	)
}

StaffingAlertEmail.PreviewProps = {
	eyebrow: 'Attendance',
	headline: '2 people have not clocked in',
	detail: 'Two scheduled people have not clocked in at Downtown.',
	actionLabel: 'Open the time clock',
	actionUrl: 'https://example.com/acme/staff/timeclock',
	settingsNote: 'You can turn these alerts off in your notification settings.',
} as StaffingAlertEmailProps
