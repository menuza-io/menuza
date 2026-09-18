import {
	Button,
	Column,
	Heading,
	Link,
	Row,
	Section,
	Text,
} from '@react-email/components'
import { type ReactNode } from 'react'

/**
 * Typography, spacing and color for the transactional emails, expressed entirely
 * through the tokens configured in `../theme.ts`.
 *
 * **Critical:** React Email inlines `m-0` as `margin:0`, which overrides
 * `mb-[*]` on `<Text>` / `<p>`. Vertical rhythm therefore lives on wrapping
 * `<Section>` elements (same pattern as {@link EmailButton} and {@link EmailCard}).
 */
const classes = (...values: Array<string | undefined>) =>
	values.filter(Boolean).join(' ')

export interface EmailCardProps {
	children: ReactNode
	/**
	 * `message` is the reference's single-message card (40/64px padding, 8px
	 * radius) used by confirmation and reset emails; `section` is its richer
	 * multi-part card (20/56px padding, 10px radius).
	 */
	size?: 'section' | 'message'
	className?: string
}

const CARD_SIZES = {
	section:
		'rounded-[10px] px-[20px] py-[56px] mobile:px-[16px] mobile:py-[40px]',
	message:
		'rounded-[8px] px-[40px] py-[64px] mobile:px-[24px] mobile:py-[48px]',
} as const

/** A tinted, rounded panel on the white sheet — the reference's structural unit. */
export function EmailCard({
	children,
	size = 'section',
	className,
}: EmailCardProps) {
	return (
		<Section
			className={classes(
				'bg-muted mobile:mb-[8px] mb-[24px]',
				CARD_SIZES[size],
				className,
			)}
		>
			{children}
		</Section>
	)
}

export interface EmailEyebrowProps {
	children: ReactNode
	align?: 'center' | 'left'
	className?: string
}

/** Small muted label above a heading. */
export function EmailEyebrow({
	children,
	align = 'center',
	className,
}: EmailEyebrowProps) {
	return (
		<Section
			align={align === 'center' ? 'center' : undefined}
			className={classes('mb-[24px]', className)}
		>
			<Text
				className={classes(
					'text-13 text-muted-foreground m-0',
					align === 'center' ? 'text-center' : 'text-left',
				)}
			>
				{children}
			</Text>
		</Section>
	)
}

export interface EmailHeadingProps {
	children: ReactNode
	/** `h2` is the smaller, left-aligned section title inside a card. */
	as?: 'h1' | 'h2'
	/** `h1` only: `hero` is the 40px marketing size, `default` the 28px transactional one. */
	size?: 'default' | 'hero'
	align?: 'center' | 'left'
	className?: string
}

export function EmailHeading({
	children,
	as = 'h1',
	size = 'default',
	align = 'center',
	className,
}: EmailHeadingProps) {
	if (as === 'h2') {
		return (
			<Section className={classes('mb-[40px]', className)}>
				<Heading
					as="h2"
					className="text-foreground text-24 m-0 text-left font-semibold"
				>
					{children}
				</Heading>
			</Section>
		)
	}

	return (
		<Section
			align={align === 'center' ? 'center' : undefined}
			className={classes('mb-[24px]', className)}
		>
			<Heading
				as="h1"
				className={classes(
					'text-foreground m-0 font-semibold',
					align === 'center'
						? classes(
								size === 'hero' ? 'text-40' : 'text-28',
								'mx-auto max-w-[440px] text-center',
							)
						: classes(size === 'hero' ? 'text-40' : 'text-28', 'text-left'),
				)}
			>
				{children}
			</Heading>
		</Section>
	)
}

export interface EmailParagraphProps {
	children: ReactNode
	align?: 'center' | 'left'
	className?: string
}

export function EmailParagraph({
	children,
	align = 'center',
	className,
}: EmailParagraphProps) {
	return (
		<Section
			align={align === 'center' ? 'center' : undefined}
			className={classes('mb-[24px]', className)}
		>
			<Text
				className={classes(
					'text-16 text-muted-foreground m-0',
					align === 'center'
						? 'mx-auto max-w-[420px] text-center'
						: 'text-left',
				)}
			>
				{children}
			</Text>
		</Section>
	)
}

export interface EmailNoteProps {
	children: ReactNode
	align?: 'center' | 'left'
	className?: string
}

/** Secondary copy: afterthoughts, expiry warnings, sign-offs. */
export function EmailNote({
	children,
	align = 'center',
	className,
}: EmailNoteProps) {
	return (
		<Section
			align={align === 'center' ? 'center' : undefined}
			className={classes('mb-[24px]', className)}
		>
			<Text
				className={classes(
					'text-13 text-muted-foreground m-0',
					align === 'center'
						? 'mx-auto max-w-[400px] text-center'
						: 'text-left',
				)}
			>
				{children}
			</Text>
		</Section>
	)
}

export interface EmailButtonProps {
	href: string
	children: ReactNode
	className?: string
}

export function EmailButton({ href, children, className }: EmailButtonProps) {
	return (
		<Section className={classes('mb-[32px] text-center', className)}>
			<Button
				href={href}
				className="bg-primary text-primary-foreground text-16 inline-block rounded-[30px] px-[28px] py-[16px] font-medium no-underline"
			>
				{children}
			</Button>
		</Section>
	)
}

export interface EmailCodeProps {
	children: ReactNode
	/** Centered line above the code box (OTP / verification emails). */
	label?: string
	className?: string
}

/** White inset box holding a one-time code. */
export function EmailCode({ children, label, className }: EmailCodeProps) {
	return (
		<>
			{label ? (
				<EmailParagraph className="mb-[12px]">{label}</EmailParagraph>
			) : null}
			<Section align="center" className="mb-[32px]">
				<Section
					className={classes(
						'bg-background w-full max-w-[320px] rounded-[10px] px-[16px] py-[16px] text-center',
						className,
					)}
				>
					<Text className="text-28 text-foreground m-0 font-semibold tracking-[0.2em]">
						{children}
					</Text>
				</Section>
			</Section>
		</>
	)
}

export interface EmailQuoteProps {
	children: ReactNode
	className?: string
}

/** White inset box holding quoted content, e.g. the comment that triggered the email. */
export function EmailQuote({ children, className }: EmailQuoteProps) {
	return (
		<Section align="center" className={classes('mb-[32px]', className)}>
			<Section className="bg-background w-full max-w-[420px] rounded-[10px] px-[20px] py-[20px]">
				<Text className="text-16 text-foreground m-0 italic">{children}</Text>
			</Section>
		</Section>
	)
}

export interface EmailLinkProps {
	href: string
	children: ReactNode
	className?: string
}

/**
 * Inline link. Deliberately `text-foreground` with an underline rather than
 * `text-primary`: at the sizes used in notes the brand green does not clear a
 * 4.5:1 contrast ratio against `bg-muted`, and this matches the reference's
 * link treatment.
 */
export function EmailLink({ href, children, className }: EmailLinkProps) {
	return (
		<Link
			href={href}
			className={classes('text-foreground underline', className)}
		>
			{children}
		</Link>
	)
}

export interface EmailFieldProps {
	label: string
	value: ReactNode
	className?: string
	align?: 'center' | 'left'
}

/** Label over value — the detail rows in the invoice and sign-in alerts. */
export function EmailField({
	label,
	value,
	className,
	align = 'left',
}: EmailFieldProps) {
	return (
		<Section className={classes('mb-[20px]', className)}>
			<Section className="mb-[4px]">
				<Text
					className={classes(
						'text-13 text-muted-foreground m-0',
						align === 'center' ? 'text-center' : 'text-left',
					)}
				>
					{label}
				</Text>
			</Section>
			<Text
				className={classes(
					'text-16 text-foreground m-0 font-medium',
					align === 'center' ? 'text-center' : 'text-left',
				)}
			>
				{value}
			</Text>
		</Section>
	)
}

export interface EmailDetailsProps {
	children: ReactNode
	align?: 'center' | 'left'
	className?: string
}

/**
 * Left-aligned stack of {@link EmailField} rows (and optional follow-up copy).
 * Default `center` nests the stack at the body measure; `left` aligns with
 * section-card copy (invite, security alert, contact).
 */
export function EmailDetails({
	children,
	align = 'center',
	className,
}: EmailDetailsProps) {
	if (align === 'left') {
		return (
			<Section className={classes('mb-[32px]', className)}>{children}</Section>
		)
	}

	return (
		<Section align="center" className={classes('mb-[32px]', className)}>
			<Section className="w-full max-w-[420px] text-left">{children}</Section>
		</Section>
	)
}

export interface EmailStepsProps {
	children: ReactNode
	align?: 'center' | 'left'
	className?: string
}

export function EmailSteps({
	children,
	align = 'center',
	className,
}: EmailStepsProps) {
	if (align === 'left') {
		return (
			<Section className={classes('mb-[40px]', className)}>{children}</Section>
		)
	}

	return (
		<Section align="center" className={classes('mb-[40px]', className)}>
			<Section className="w-full max-w-[440px] text-left">{children}</Section>
		</Section>
	)
}

export interface EmailStepProps {
	n: number
	title: string
	/** Optional: plenty of lists are a title alone. */
	body?: string
	/** Drops the bottom margin so the list ends flush with the card padding. */
	last?: boolean
}

/** A numbered step: bordered badge, bold title, muted body. */
export function EmailStep({ n, title, body, last }: EmailStepProps) {
	return (
		<Row className={last ? undefined : 'mb-[36px]'}>
			<Column className="w-[40px] pr-[12px] align-top">
				<Section className="bg-background border-border w-[28px] rounded-[10px] border border-solid py-[4px] text-center">
					<Text className="text-13 text-foreground m-0 leading-[18px] font-medium">
						{n}
					</Text>
				</Section>
			</Column>
			<Column className="align-top">
				<Section className="mb-[4px]">
					<Text className="text-16 text-foreground m-0 font-semibold">
						{title}
					</Text>
				</Section>
				{body ? (
					<Text className="text-16 text-muted-foreground m-0">{body}</Text>
				) : null}
			</Column>
		</Row>
	)
}
