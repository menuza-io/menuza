import { Container, Img, Link, Section, Text } from '@react-email/components'
import { type EmailBlock } from '@repo/common/email-blocks'
import { resolveEmailAssetUrl, type EmailTheme } from '@repo/common/email-theme'

import { EmailBlocks } from './blocks.tsx'

export type EmailSocialLink = {
	platform: string
	url: string
}

/** Text-only unsubscribe line. A working opt-out is a follow-up. */
export const DEFAULT_UNSUBSCRIBE_TEXT =
	'If you no longer wish to receive these emails, you can unsubscribe.'

export type EmailBodyProps = {
	blocks: EmailBlock[]
	theme: EmailTheme
	socials?: EmailSocialLink[]
	unsubscribeText?: string
}

export function EmailBody({
	blocks,
	theme,
	socials = [],
	unsubscribeText = DEFAULT_UNSUBSCRIBE_TEXT,
}: EmailBodyProps) {
	const logoUrl = resolveEmailAssetUrl(theme.logoUrl, theme.appUrl)
	const hasHeader = Boolean(logoUrl || theme.organizationName)
	const copyright = theme.organizationName
		? `© ${new Date().getFullYear()} ${theme.organizationName}. All rights reserved.`
		: null

	// Most light presets resolve `background` and `card` to the same white, which
	// makes the card invisible. Fall back to `muted` for the page so the email
	// reads as a surface floating on a tinted backdrop.
	const pageBackground =
		theme.background.toLowerCase() === theme.card.toLowerCase()
			? theme.muted
			: theme.background

	return (
		<Section
			style={{
				backgroundColor: pageBackground,
				padding: '40px 16px',
				fontFamily: theme.bodyFont,
			}}
		>
			<Container style={{ maxWidth: '600px', margin: '0 auto' }}>
				<Section
					style={{
						backgroundColor: theme.card,
						border: `1px solid ${theme.border}`,
						borderRadius: `${theme.radius}px`,
						padding: '36px 32px',
					}}
				>
					{hasHeader ? (
						<Section
							style={{
								borderBottom: `1px solid ${theme.border}`,
								paddingBottom: '24px',
								marginBottom: '28px',
								textAlign: 'center',
							}}
						>
							{logoUrl ? (
								<Img
									src={logoUrl}
									alt={theme.organizationName}
									width={44}
									height={44}
									style={{
										display: 'inline-block',
										width: '44px',
										height: '44px',
										objectFit: 'contain',
										borderRadius: `${theme.radius}px`,
									}}
								/>
							) : null}
							{theme.organizationName ? (
								<Text
									style={{
										margin: logoUrl ? '12px 0 0' : '0',
										fontFamily: theme.headingFont,
										fontSize: '17px',
										lineHeight: '1.2',
										fontWeight: 700,
										letterSpacing: '-0.01em',
										color: theme.foreground,
									}}
								>
									{theme.organizationName}
								</Text>
							) : null}
						</Section>
					) : null}

					<EmailBlocks blocks={blocks} theme={theme} />
				</Section>

				<Section
					style={{
						marginTop: '28px',
						textAlign: 'center',
					}}
				>
					{socials.length > 0 ? (
						<Text style={{ margin: '0 0 14px' }}>
							{socials.map((social, index) => (
								<span key={`${social.platform}-${index}`}>
									{index > 0 ? (
										<span style={{ color: theme.mutedForeground }}> · </span>
									) : null}
									<Link
										href={social.url}
										style={{
											color: theme.mutedForeground,
											fontSize: '13px',
											fontWeight: 500,
											textDecoration: 'none',
										}}
									>
										{social.platform}
									</Link>
								</span>
							))}
						</Text>
					) : null}

					<Text
						style={{
							margin: '0',
							color: theme.mutedForeground,
							fontSize: '12px',
							lineHeight: '1.7',
						}}
					>
						{unsubscribeText}
					</Text>
					{copyright ? (
						<Text
							style={{
								margin: '6px 0 0',
								color: theme.mutedForeground,
								fontSize: '12px',
								lineHeight: '1.7',
							}}
						>
							{copyright}
						</Text>
					) : null}
				</Section>
			</Container>
		</Section>
	)
}
