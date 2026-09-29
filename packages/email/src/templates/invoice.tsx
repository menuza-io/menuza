import { Column, Hr, Row, Text } from '@react-email/components'
import { brand } from '@repo/config/brand'

import {
	EmailButton,
	EmailCard,
	EmailEyebrow,
	EmailField,
	EmailHeading,
	EmailLayout,
	EmailParagraph,
} from '../components'

export interface InvoiceEmailProps {
	orderNumber: string
	invoiceDate: string
	customerName: string
	customerEmail: string
	items: Array<{
		name: string
		description: string
		quantity: number
		amount: string
	}>
	subtotal: string
	tax: string
	total: string
	downloadUrl: string
}

const InvoiceEmail = (props: InvoiceEmailProps) => {
	const items = props.items ?? []

	return (
		<EmailLayout
			preview={`Invoice ${props.orderNumber} - Your ${brand.name} purchase confirmation`}
		>
			<EmailCard>
				<EmailEyebrow align="left">Billing</EmailEyebrow>

				<EmailHeading align="left" className="mb-[40px]">
					Invoice {props.orderNumber}
				</EmailHeading>

				<Row>
					<Column className="mobile:!block mobile:!w-full mobile:!max-w-full mobile:mb-[20px] mobile:pr-0 w-1/2 pr-[12px] align-top">
						<EmailField label="Invoice number" value={props.orderNumber} />
						<EmailField
							label="Invoice date"
							value={props.invoiceDate}
							className="mb-0"
						/>
					</Column>
					<Column className="mobile:!block mobile:!w-full mobile:!max-w-full w-1/2 align-top">
						<EmailField label="Billed to" value={props.customerName} />
						<EmailField
							label="Email"
							value={props.customerEmail}
							className="mb-0"
						/>
					</Column>
				</Row>
			</EmailCard>

			<EmailCard>
				<EmailHeading as="h2">Order summary</EmailHeading>

				<Row className="border-border mb-[16px] border-b border-solid pb-[12px]">
					<Column className="w-1/2">
						<Text className="text-13 text-muted-foreground m-0 text-left">
							Item
						</Text>
					</Column>
					<Column className="w-1/4">
						<Text className="text-13 text-muted-foreground m-0 text-center">
							Qty
						</Text>
					</Column>
					<Column className="w-1/4">
						<Text className="text-13 text-muted-foreground m-0 text-right">
							Amount
						</Text>
					</Column>
				</Row>

				{items.map((item, index) => (
					<Row
						key={index}
						className={index === items.length - 1 ? undefined : 'mb-[16px]'}
					>
						<Column className="w-1/2 align-top">
							<Text className="text-16 text-foreground m-0 text-left font-medium">
								{item.name}
							</Text>
							<Text className="text-13 text-muted-foreground m-0 text-left">
								{item.description}
							</Text>
						</Column>
						<Column className="w-1/4 align-top">
							<Text className="text-16 text-foreground m-0 text-center">
								{item.quantity}
							</Text>
						</Column>
						<Column className="w-1/4 align-top">
							<Text className="text-16 text-foreground m-0 text-right font-medium">
								${item.amount}
							</Text>
						</Column>
					</Row>
				))}

				<Hr className="border-border my-[24px]" />

				<Row className="mb-[8px]">
					<Column className="w-3/4">
						<Text className="text-16 text-muted-foreground m-0 text-right">
							Subtotal
						</Text>
					</Column>
					<Column className="w-1/4">
						<Text className="text-16 text-foreground m-0 text-right">
							${props.subtotal}
						</Text>
					</Column>
				</Row>

				<Row className="mb-[20px]">
					<Column className="w-3/4">
						<Text className="text-16 text-muted-foreground m-0 text-right">
							Tax
						</Text>
					</Column>
					<Column className="w-1/4">
						<Text className="text-16 text-foreground m-0 text-right">
							${props.tax}
						</Text>
					</Column>
				</Row>

				<Row className="border-border border-t border-solid pt-[16px]">
					<Column className="w-3/4">
						<Text className="text-16 text-foreground m-0 text-right">
							Total
						</Text>
					</Column>
					<Column className="w-1/4">
						<Text className="text-16 text-foreground m-0 text-right">
							${props.total}
						</Text>
					</Column>
				</Row>
			</EmailCard>

			<EmailCard size="message">
				<EmailButton href={props.downloadUrl}>Download Invoice</EmailButton>

				<EmailParagraph className="mb-0">
					Questions about your invoice? Our support team is here to help.
				</EmailParagraph>
			</EmailCard>
		</EmailLayout>
	)
}

InvoiceEmail.PreviewProps = {
	orderNumber: 'INV-2025-001234',
	invoiceDate: 'January 24, 2025',
	customerName: `${brand.name} Pro`,
	customerEmail: 'alex@example.com',
	items: [
		{
			name: `${brand.name} Pro Plan`,
			description: 'Monthly subscription',
			quantity: 1,
			amount: '29.00',
		},
		{
			name: 'Team Collaboration',
			description: 'Additional team member seats (5 users)',
			quantity: 5,
			amount: '75.00',
		},
		{
			name: 'Premium Support',
			description: 'Priority customer support and onboarding',
			quantity: 1,
			amount: '15.00',
		},
	],
	subtotal: '119.00',
	tax: '9.52',
	total: '128.52',
	downloadUrl: 'https://example.com/invoice/download/INV-2025-001234',
}

export default InvoiceEmail
