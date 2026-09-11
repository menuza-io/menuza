import {
	Button,
	Heading,
	Img,
	Link,
	Section,
	Text,
} from '@react-email/components'
import {
	type EmailBlock,
	type EmailBodyBlock,
	type EmailButtonBlock,
	type EmailHeadingBlock,
	type EmailImageBlock,
	type EmailParagraphBlock,
} from '@repo/common/email-blocks'
import { resolveEmailAssetUrl, type EmailTheme } from '@repo/common/email-theme'
import { Fragment, type CSSProperties } from 'react'

export type EmailBlockViewProps = {
	block: EmailBlock
	theme: EmailTheme
}

const HEADING_SIZE: Record<EmailHeadingBlock['config']['level'], number> = {
	h1: 30,
	h2: 24,
	h3: 19,
}

/**
 * Render authored text with its line breaks intact.
 *
 * HTML collapses whitespace, so a newline typed in the editor would otherwise
 * render on the same line. Explicit `<br />` tags are the most widely supported
 * way to preserve them in email clients (better than `white-space: pre-wrap`).
 */
function TextWithLineBreaks({ text }: { text: string }) {
	const lines = text.split('\n')
	if (lines.length === 1) return <>{text}</>
	return (
		<>
			{lines.map((line, index) => (
				<Fragment key={index}>
					{index > 0 ? <br /> : null}
					{line}
				</Fragment>
			))}
		</>
	)
}

function HeadingBlock({
	block,
	theme,
}: {
	block: EmailHeadingBlock
	theme: EmailTheme
}) {
	const { text, level, align } = block.config
	if (!text.trim()) return null
	return (
		<Heading
			as={level}
			style={{
				margin: '0 0 14px',
				fontFamily: theme.headingFont,
				fontSize: `${HEADING_SIZE[level]}px`,
				lineHeight: '1.25',
				fontWeight: 700,
				letterSpacing: '-0.015em',
				color: theme.foreground,
				textAlign: align,
			}}
		>
			<TextWithLineBreaks text={text} />
		</Heading>
	)
}

function BodyBlock({
	block,
	theme,
}: {
	block: EmailBodyBlock
	theme: EmailTheme
}) {
	if (!block.config.text.trim()) return null
	return (
		<Text
			style={{
				margin: '0 0 16px',
				fontFamily: theme.bodyFont,
				fontSize: '16px',
				lineHeight: '1.65',
				color: theme.foreground,
			}}
		>
			<TextWithLineBreaks text={block.config.text} />
		</Text>
	)
}

function ParagraphBlock({
	block,
	theme,
}: {
	block: EmailParagraphBlock
	theme: EmailTheme
}) {
	if (!block.config.text.trim()) return null
	return (
		<Text
			style={{
				margin: '0 0 16px',
				fontFamily: theme.bodyFont,
				fontSize: '14px',
				lineHeight: '1.65',
				color: theme.mutedForeground,
			}}
		>
			<TextWithLineBreaks text={block.config.text} />
		</Text>
	)
}

function ImageBlock({
	block,
	theme,
}: {
	block: EmailImageBlock
	theme: EmailTheme
}) {
	const src = resolveEmailAssetUrl(block.config.url, theme.appUrl)
	if (!src) return null

	const fullWidth = block.config.width >= 100
	const image = (
		<Img
			src={src}
			alt={block.config.alt}
			style={{
				display: 'inline-block',
				width: fullWidth ? '100%' : `${block.config.width}%`,
				maxWidth: '100%',
				height: 'auto',
				borderRadius: `${theme.radius}px`,
			}}
		/>
	)

	return (
		<Section
			style={{
				margin: '0 0 20px',
				textAlign: block.config.align,
			}}
		>
			{block.config.href ? (
				<Link href={block.config.href}>{image}</Link>
			) : (
				image
			)}
		</Section>
	)
}

function ButtonBlock({
	block,
	theme,
}: {
	block: EmailButtonBlock
	theme: EmailTheme
}) {
	const { label, url, variant, width, align } = block.config
	if (!label.trim()) return null

	const isPrimary = variant === 'primary'
	// A full-width button spans the email content width; the anchor becomes a
	// block and the label is centred (alignment no longer applies).
	const isFullWidth = width === 'full'
	const style: CSSProperties = {
		backgroundColor: isPrimary ? theme.primary : 'transparent',
		color: isPrimary ? theme.primaryForeground : theme.primary,
		border: isPrimary ? 'none' : `1px solid ${theme.primary}`,
		borderRadius: `${theme.radius}px`,
		padding: '13px 26px',
		fontFamily: theme.bodyFont,
		fontSize: '15px',
		fontWeight: 600,
		lineHeight: '1.2',
		letterSpacing: '0.01em',
		textDecoration: 'none',
		display: isFullWidth ? 'block' : 'inline-block',
		...(isFullWidth
			? { width: '100%', boxSizing: 'border-box', textAlign: 'center' }
			: null),
	}

	return (
		<Section
			style={{
				margin: '8px 0 20px',
				textAlign: isFullWidth ? 'center' : align,
				...(isFullWidth ? { width: '100%' } : null),
			}}
		>
			{url.trim() ? (
				<Button href={url} style={style}>
					{label}
				</Button>
			) : (
				<span style={style}>{label}</span>
			)}
		</Section>
	)
}

export function EmailBlockView({ block, theme }: EmailBlockViewProps) {
	switch (block.type) {
		case 'heading':
			return <HeadingBlock block={block} theme={theme} />
		case 'body':
			return <BodyBlock block={block} theme={theme} />
		case 'paragraph':
			return <ParagraphBlock block={block} theme={theme} />
		case 'image':
			return <ImageBlock block={block} theme={theme} />
		case 'button':
			return <ButtonBlock block={block} theme={theme} />
		default:
			return null
	}
}

export function EmailBlocks({
	blocks,
	theme,
}: {
	blocks: EmailBlock[]
	theme: EmailTheme
}) {
	return (
		<>
			{blocks.map((block) => (
				<EmailBlockView key={block.id} block={block} theme={theme} />
			))}
		</>
	)
}
