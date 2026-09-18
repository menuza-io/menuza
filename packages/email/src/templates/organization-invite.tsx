import { brand, getBrandTeam } from '@repo/config/brand'

import {
	EmailButton,
	EmailCard,
	EmailEyebrow,
	EmailHeading,
	EmailLayout,
	EmailNote,
	EmailParagraph,
	EmailStep,
	EmailSteps,
} from '../components'

export interface OrganizationInviteEmailProps {
	inviteUrl: string
	organizationName: string
	inviterName: string
	firstName?: string
}

export default function OrganizationInviteEmail({
	inviteUrl,
	organizationName,
	inviterName,
	firstName = 'Developer',
}: OrganizationInviteEmailProps) {
	return (
		<EmailLayout
			preview={`You're invited to join ${organizationName} on ${brand.name}`}
			fallbackUrl={inviteUrl}
		>
			<EmailCard>
				<EmailEyebrow align="left">Invitation</EmailEyebrow>

				<EmailHeading align="left">
					Join {organizationName}, {firstName}!
				</EmailHeading>

				<EmailParagraph align="left" className="mb-[32px]">
					Great news! {inviterName} has invited you to collaborate with{' '}
					{organizationName} on {brand.name}. You'll be able to collaborate with
					your team and stay up to date with everything happening in the
					organization.
				</EmailParagraph>

				<EmailSteps align="left">
					<EmailStep n={1} title="Collaborate with your team" />
					<EmailStep
						n={2}
						title="Access organization-wide templates and resources"
					/>
					<EmailStep
						n={3}
						title="Stay up to date with projects and updates"
						last
					/>
				</EmailSteps>

				<EmailButton href={inviteUrl}>Accept Invitation</EmailButton>

				<EmailNote align="left">
					If you didn't expect this invitation, you can safely ignore this
					email. No account will be created without your explicit consent.
				</EmailNote>

				<EmailNote align="left" className="mb-0">
					Welcome to the team!
					<br />
					{getBrandTeam()}
				</EmailNote>
			</EmailCard>
		</EmailLayout>
	)
}

OrganizationInviteEmail.PreviewProps = {
	inviteUrl: 'https://example.com/join/abc123',
	organizationName: 'Acme Corp',
	inviterName: 'John Doe',
	firstName: 'Alex',
} as OrganizationInviteEmailProps
