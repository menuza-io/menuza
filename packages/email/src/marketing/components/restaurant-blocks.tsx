import {
	Button,
	Column,
	Img,
	Row,
	Section,
	Text,
} from '@react-email/components'
import { type EmailRenderContext } from '@repo/common/email-block-base'
import {
	EMAIL_COUPON_BUTTON_PATH,
	emailImageUrl,
	emailSiteUrl,
	formatEmailPrice,
	orderButtonLabel,
	type EmailCouponBlock,
	type EmailMenuItemBlock,
} from '@repo/common/email-blocks-restaurant'
import { type EmailTheme } from '@repo/common/email-theme'
import { type CSSProperties } from 'react'

/**
 * The restaurant vertical's block views: a row of dishes and a coupon box.
 * Every string is rendered as a React text child (escaped by the renderer) and
 * every link is built from the organization's own site origin, never from
 * stored text.
 */

function textStart(context: EmailRenderContext): 'left' | 'right' {
	return context.direction === 'rtl' ? 'right' : 'left'
}

export function MenuItemBlockView({
	block,
	theme,
	context,
}: {
	block: EmailMenuItemBlock
	theme: EmailTheme
	context: EmailRenderContext
}) {
	const items = block.config.snapshot?.items ?? []
	if (items.length === 0) return null
	const columns = items.length
	const start = textStart(context)
	const locale = context.locale ?? 'en'

	return (
		<Section
			dir={context.direction}
			style={{ margin: '0 0 20px' }}
			data-block="menu_item"
		>
			<Row>
				{items.map((item, index) => {
					const photo = emailImageUrl(item.imageUrl, {
						columns,
						transformBase: context.imageTransformBase,
					})
					const href = emailSiteUrl(context, item.path)
					const showPrice = block.config.showPrice && item.priceMinor !== null
					const buttonStyle: CSSProperties = {
						backgroundColor: theme.primary,
						color: theme.primaryForeground,
						borderRadius: `${theme.radius}px`,
						padding: '10px 20px',
						fontFamily: theme.bodyFont,
						fontSize: '14px',
						fontWeight: 600,
						lineHeight: '1.2',
						textDecoration: 'none',
						display: 'inline-block',
					}
					return (
						<Column
							key={`${item.itemId}-${index}`}
							style={{
								width: `${100 / columns}%`,
								verticalAlign: 'top',
								padding: columns > 1 ? '0 6px' : '0',
								textAlign: start,
							}}
						>
							{photo ? (
								<Img
									src={photo}
									alt={item.name}
									style={{
										display: 'block',
										width: '100%',
										maxWidth: '100%',
										height: 'auto',
										borderRadius: `${theme.radius}px`,
									}}
								/>
							) : null}
							<Text
								style={{
									margin: '12px 0 4px',
									fontFamily: theme.headingFont,
									fontSize: columns > 1 ? '16px' : '20px',
									lineHeight: '1.3',
									fontWeight: 700,
									color: theme.foreground,
									textAlign: start,
								}}
							>
								{item.name}
							</Text>
							{block.config.showDescription && item.description ? (
								<Text
									style={{
										margin: '0 0 6px',
										fontFamily: theme.bodyFont,
										fontSize: '14px',
										lineHeight: '1.55',
										color: theme.mutedForeground,
										textAlign: start,
									}}
								>
									{item.description}
								</Text>
							) : null}
							{showPrice ? (
								<Text
									style={{
										margin: '0 0 10px',
										fontFamily: theme.bodyFont,
										fontSize: '15px',
										fontWeight: 600,
										color: theme.foreground,
										textAlign: start,
									}}
								>
									{formatEmailPrice(item.priceMinor!, item.currency, locale)}
								</Text>
							) : null}
							{href ? (
								<Button href={href} style={buttonStyle}>
									{orderButtonLabel(locale)}
								</Button>
							) : null}
						</Column>
					)
				})}
			</Row>
		</Section>
	)
}

export function CouponBlockView({
	block,
	theme,
	context,
}: {
	block: EmailCouponBlock
	theme: EmailTheme
	context: EmailRenderContext
}) {
	const coupon = context.coupon
	// No coupon on the message: nothing to show. The pre-send check refuses it.
	if (!coupon) return null
	const href = emailSiteUrl(context, EMAIL_COUPON_BUTTON_PATH)
	const ticket = block.config.style === 'ticket'

	return (
		<Section
			dir={context.direction}
			data-block="coupon"
			style={{
				margin: '8px 0 20px',
				padding: '24px 20px',
				textAlign: 'center',
				backgroundColor: ticket ? theme.accent : theme.card,
				border: `${ticket ? '2px dashed' : '1px solid'} ${theme.primary}`,
				borderRadius: `${theme.radius}px`,
			}}
		>
			<Text
				style={{
					margin: '0 0 12px',
					fontFamily: theme.headingFont,
					fontSize: '28px',
					lineHeight: '1.2',
					fontWeight: 700,
					color: theme.foreground,
					textAlign: 'center',
				}}
			>
				{coupon.headline}
			</Text>
			<Text
				style={{
					margin: '0 auto 12px',
					display: 'inline-block',
					padding: '8px 18px',
					border: `1px dashed ${theme.mutedForeground}`,
					borderRadius: `${theme.radius}px`,
					fontFamily: 'Menlo, Consolas, monospace',
					fontSize: '20px',
					letterSpacing: '0.12em',
					fontWeight: 700,
					color: theme.foreground,
				}}
			>
				{'{{couponCode}}'}
			</Text>
			{coupon.terms ? (
				<Text
					style={{
						margin: '0 0 16px',
						fontFamily: theme.bodyFont,
						fontSize: '13px',
						lineHeight: '1.55',
						color: theme.mutedForeground,
						textAlign: 'center',
					}}
				>
					{coupon.terms}
				</Text>
			) : null}
			{href ? (
				<Button
					href={href}
					style={{
						backgroundColor: theme.primary,
						color: theme.primaryForeground,
						borderRadius: `${theme.radius}px`,
						padding: '13px 26px',
						fontFamily: theme.bodyFont,
						fontSize: '15px',
						fontWeight: 600,
						lineHeight: '1.2',
						textDecoration: 'none',
						display: 'inline-block',
					}}
				>
					{coupon.buttonLabel}
				</Button>
			) : null}
		</Section>
	)
}
