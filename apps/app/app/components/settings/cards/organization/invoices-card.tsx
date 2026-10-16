import { t, Trans } from '@lingui/macro'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Frame,
	FramePanel,
	FrameDescription,
	FrameHeader,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemHeader,
	ItemMedia,
	ItemTitle,
} from '@repo/ui/item'
import { Link } from 'react-router'

import { EmptyState } from '#app/components/empty-state.tsx'

type Invoice = {
	id?: string
	number: string | null
	status: string | null
	amountPaid: number
	amountDue: number
	currency: string
	created: number
	dueDate: number | null
	hostedInvoiceUrl: string | null
	invoicePdf: string | null
	periodStart: number | null
	periodEnd: number | null
}

type InvoicesCardProps = {
	invoices: Invoice[]
	invoicesUnavailable?: boolean
}

export function InvoicesCard({
	invoices,
	invoicesUnavailable,
}: InvoicesCardProps) {
	const formatCurrency = (amount: number, currency: string) => {
		return new Intl.NumberFormat('en-US', {
			style: 'currency',
			currency: currency.toUpperCase(),
		}).format(amount / 100)
	}

	const formatDate = (timestamp: number) => {
		return new Date(timestamp * 1000).toLocaleDateString('en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
		})
	}

	const getStatusBadge = (status: string | null) => {
		switch (status) {
			case 'paid':
				return <Badge variant="default">Paid</Badge>
			case 'open':
				return <Badge variant="secondary">Open</Badge>
			case 'void':
				return <Badge variant="outline">Void</Badge>
			case 'uncollectible':
				return <Badge variant="destructive">Uncollectible</Badge>
			default:
				return <Badge variant="outline">{status || 'Unknown'}</Badge>
		}
	}

	return (
		<Frame>
			<FrameHeader>
				<FrameTitle>
					<Trans>Invoices</Trans>
				</FrameTitle>
				<FrameDescription>
					<Trans>View and download your billing invoices</Trans>
				</FrameDescription>
			</FrameHeader>
			<FramePanel className="p-0">
				{invoicesUnavailable ? (
					<div className="border-b border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
						<Trans>Invoice history is temporarily unavailable.</Trans>
					</div>
				) : null}
				{!invoicesUnavailable && invoices.length === 0 ? (
					<EmptyState
						title={t`No invoices found`}
						description={t`Invoices will appear here once you have an active subscription.`}
						icons={['file-text']}
					/>
				) : null}
				{invoices.length > 0 ? (
					<div className="space-y-3 p-6">
						{invoices.map((invoice) => (
							<Item key={invoice.id} size="sm">
								<ItemMedia variant="icon">
									<Icon name="file-text" className="h-4 w-4" />
								</ItemMedia>
								<ItemContent className="min-w-0">
									<ItemHeader>
										<ItemTitle className="truncate">
											{invoice.number || `Invoice ${invoice.id?.slice(-8)}`}
										</ItemTitle>
										{getStatusBadge(invoice.status)}
									</ItemHeader>
									<ItemDescription className="text-xs sm:text-sm">
										{formatDate(invoice.created)}
										{invoice.periodStart && invoice.periodEnd && (
											<span className="ml-2">
												({formatDate(invoice.periodStart)} -{' '}
												{formatDate(invoice.periodEnd)})
											</span>
										)}
									</ItemDescription>
								</ItemContent>
								<ItemActions className="flex flex-wrap justify-end gap-3 sm:flex-nowrap sm:items-center">
									<div className="text-right text-sm">
										<p className="font-medium">
											{formatCurrency(invoice.amountPaid, invoice.currency)}
										</p>
										{invoice.amountDue > 0 && (
											<p className="text-muted-foreground text-xs">
												Due:{' '}
												{formatCurrency(invoice.amountDue, invoice.currency)}
											</p>
										)}
									</div>
									<div className="flex gap-2">
										{invoice.hostedInvoiceUrl && (
											<Button variant="outline" size="sm">
												<Link
													to={invoice.hostedInvoiceUrl}
													target="_blank"
													rel="noopener noreferrer"
												>
													<Icon name="external-link" className="h-4 w-4" />
													<Trans>View</Trans>
												</Link>
											</Button>
										)}
										{invoice.invoicePdf && (
											<Button variant="outline" size="sm">
												<Link
													to={invoice.invoicePdf}
													target="_blank"
													rel="noopener noreferrer"
												>
													<Icon name="download" className="h-4 w-4" />
													PDF
												</Link>
											</Button>
										)}
									</div>
								</ItemActions>
							</Item>
						))}
					</div>
				) : null}
			</FramePanel>
		</Frame>
	)
}
