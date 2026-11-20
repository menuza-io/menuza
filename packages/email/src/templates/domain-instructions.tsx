import {
	EmailCard,
	EmailEyebrow,
	EmailHeading,
	EmailLayout,
	EmailNote,
	EmailParagraph,
	EmailStep,
	EmailSteps,
} from '../components'

export interface DomainInstructionsEmailProps {
	restaurantName: string
	domain: string
	/** The operator who asked, so the reader knows why this arrived. */
	requestedBy: string
	steps: string[]
	/** The records to add, one per line (`CNAME www.example.com sites.example.io`). */
	records: string[]
	providerName?: string | null
}

/**
 * Instructions for whoever manages a restaurant's domain (#313): the records
 * to add and the steps at their DNS provider. The restaurant's operator sends
 * it; nothing in it changes anything by itself.
 */
export default function DomainInstructionsEmail({
	restaurantName,
	domain,
	requestedBy,
	steps,
	records,
	providerName,
}: DomainInstructionsEmailProps) {
	return (
		<EmailLayout preview={`Connect ${domain} to ${restaurantName}'s website`}>
			<EmailCard size="message">
				<EmailEyebrow align="left">Domain setup</EmailEyebrow>
				<EmailHeading align="left">
					Please connect {domain} to {restaurantName}'s website
				</EmailHeading>
				<EmailParagraph align="left">
					{requestedBy} from {restaurantName} asked you to add these DNS records
					{providerName ? ` at ${providerName}` : ''}. Nothing changes until you
					add them, and the records do not touch email.
				</EmailParagraph>
				<EmailSteps align="left">
					{steps.map((step, index) => (
						<EmailStep
							key={step}
							n={index + 1}
							title={step}
							last={index === steps.length - 1}
						/>
					))}
				</EmailSteps>
				<EmailParagraph align="left">Records to add:</EmailParagraph>
				{records.map((record) => (
					<EmailParagraph key={record} align="left" className="mb-[8px]">
						{record}
					</EmailParagraph>
				))}
				<EmailNote>
					If you did not expect this message, you can ignore it. No account is
					created for you.
				</EmailNote>
			</EmailCard>
		</EmailLayout>
	)
}

DomainInstructionsEmail.PreviewProps = {
	restaurantName: 'Al Bait',
	domain: 'albait.com',
	requestedBy: 'Sara',
	steps: [
		'Sign in to GoDaddy.',
		'Open the DNS records.',
		'Add the records below and save.',
	],
	records: ['CNAME www.albait.com sites.menuza.io'],
	providerName: 'GoDaddy',
} satisfies DomainInstructionsEmailProps
