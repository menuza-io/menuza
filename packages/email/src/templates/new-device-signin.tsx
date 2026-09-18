import { brand } from '@repo/config/brand'

import {
	EmailButton,
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

export interface NewDeviceSigninEmailProps {
	firstName?: string
	deviceName: string
	operatingSystem: string
	location?: string
	ipAddress: string
	timestamp: string
	secureAccountUrl: string
}

export default function NewDeviceSigninEmail({
	firstName = 'there',
	deviceName,
	operatingSystem,
	location,
	ipAddress,
	timestamp,
	secureAccountUrl,
}: NewDeviceSigninEmailProps) {
	return (
		<EmailLayout preview={`New sign-in detected to your ${brand.name} account`}>
			<EmailCard>
				<EmailEyebrow align="left">Security alert</EmailEyebrow>

				<EmailHeading align="left">New sign-in detected</EmailHeading>

				<EmailParagraph align="left">
					Hi {firstName}, we detected a new sign-in to your {brand.name} account
					from a device we don't recognize.
				</EmailParagraph>

				<EmailDetails align="left" className="mb-8">
					<EmailField label="Browser" value={deviceName} />
					<EmailField label="Operating system" value={operatingSystem} />
					{location ? <EmailField label="Location" value={location} /> : null}
					<EmailField label="IP address" value={ipAddress} />
					<EmailField label="Time" value={timestamp} className="mb-0" />
				</EmailDetails>

				<EmailButton href={secureAccountUrl}>Secure My Account</EmailButton>

				<EmailNote align="left">
					If this was you, you can safely ignore this email. If you don't
					recognize this activity, secure your account immediately.
				</EmailNote>

				<EmailNote align="left" className="mb-0">
					Still unsure?{' '}
					<EmailLink href={`mailto:${brand.supportEmail}`}>
						Contact support
					</EmailLink>
					{' · '}
					<EmailLink href={`${brand.url}/security`}>Security center</EmailLink>
				</EmailNote>
			</EmailCard>
		</EmailLayout>
	)
}

NewDeviceSigninEmail.PreviewProps = {
	firstName: 'Alex',
	deviceName: 'Chrome on macOS',
	operatingSystem: 'macOS 14.2',
	location: 'San Francisco, CA, United States',
	ipAddress: '192.168.1.1',
	timestamp: 'January 15, 2025 at 3:45 PM UTC',
	secureAccountUrl: 'https://example.com/settings/security',
} as NewDeviceSigninEmailProps
