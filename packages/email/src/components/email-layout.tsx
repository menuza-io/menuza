import {
	Body,
	Column,
	Container,
	Head,
	Html,
	Img,
	Preview,
	Row,
	Section,
	Tailwind,
	Text,
} from '@react-email/components'
import { brand, getCopyright } from '@repo/config/brand'
import { type ReactNode } from 'react'

import {
	emailBrandLogoSize,
	emailBrandLogoUrl,
	emailTailwindConfig,
} from '../theme'

export interface EmailLayoutProps {
	/** Inbox preview text. */
	preview: string
	/** One or more `EmailCard` siblings. */
	children: ReactNode
	/** Magic link repeated in the footer for clients that strip the button. */
	fallbackUrl?: string
}

/** Centered footer line — each block gets its own aligned table (email-safe). */
function EmailFooterBlock({
	children,
	className,
	measure,
	size = '13',
}: {
	children: ReactNode
	className?: string
	measure?: '280' | '420' | 'full'
	size?: '11' | '13'
}) {
	const measureClass =
		measure === '280'
			? 'max-w-[280px]'
			: measure === '420'
				? 'max-w-[420px]'
				: undefined

	return (
		<Section align="center" className={className}>
			<Section className={measureClass}>
				<Text
					className={
						size === '11'
							? measure === '420'
								? 'text-11 text-muted-foreground m-0 text-center break-all'
								: 'text-11 text-muted-foreground m-0 text-center'
							: 'text-13 text-muted-foreground m-0 text-center'
					}
				>
					{children}
				</Text>
			</Section>
		</Section>
	)
}

/**
 * The boxed email shell: a tinted page, a square white sheet, a header row and a
 * footer. Templates only supply the cards in between.
 */
export function EmailLayout({
	preview,
	children,
	fallbackUrl,
}: EmailLayoutProps) {
	return (
		<Html lang="en" dir="ltr">
			<Tailwind config={emailTailwindConfig}>
				<Head />
				<Preview>{preview}</Preview>
				<Body className="bg-muted m-0 font-sans">
					<Container className="mobile:mt-0 mx-auto mt-[32px] w-full max-w-[640px]">
						<Section className="bg-background mobile:px-[8px] px-[24px] py-[16px]">
							<Section className="mb-[12px]">
								<Row>
									<Column className="w-[40px] py-[7px] align-middle">
										<Img
											src={emailBrandLogoUrl}
											alt={brand.name}
											width={emailBrandLogoSize}
											height={emailBrandLogoSize}
											className="block"
										/>
									</Column>
									<Column align="right" className="py-[7px] align-middle">
										<Text className="text-13 text-muted-foreground m-0 text-right">
											{brand.name}
										</Text>
									</Column>
								</Row>
							</Section>

							{children}

							<Section className="py-[40px]">
								<EmailFooterBlock measure="280" className="mb-[32px]" size="13">
									{brand.tagline}
								</EmailFooterBlock>
								{fallbackUrl ? (
									<EmailFooterBlock
										measure="420"
										className="mb-[20px]"
										size="11"
									>
										If the button doesn&apos;t work, copy this link:{' '}
										{fallbackUrl}
									</EmailFooterBlock>
								) : null}
								<EmailFooterBlock measure="full" size="11">
									{getCopyright()}
								</EmailFooterBlock>
							</Section>
						</Section>
					</Container>
				</Body>
			</Tailwind>
		</Html>
	)
}
