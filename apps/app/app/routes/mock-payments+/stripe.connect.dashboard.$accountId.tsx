import { Trans } from '@lingui/macro'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { getPaymentsEmulator } from '#app/utils/payments-mock/emulator.server.ts'
import { requirePaymentsMock } from '#app/utils/payments-mock/gate.server.ts'
import { formatMinor, MockPage } from './__mock-page.tsx'

type Row = { id: string; amount: number; currency: string; extra: string }

function toRows(
	items: Array<Record<string, unknown>>,
	extra: (item: Record<string, unknown>) => string,
): Row[] {
	return items.map((item) => ({
		id: String(item.id),
		amount: Number(item.amount),
		currency: String(item.currency ?? 'usd'),
		extra: extra(item),
	}))
}

/** The Express login link target: `/mock-payments/stripe/connect/dashboard/:accountId`. */
export async function loader({ request, params }: LoaderFunctionArgs) {
	requirePaymentsMock(request, 'stripe')
	const emulator = getPaymentsEmulator()
	const accountId = params.accountId ?? ''
	const account = await emulator.pages.stripe.describeAccount(accountId)
	if (!account) throw new Response('Not Found', { status: 404 })
	const ledger = await emulator.pages.stripe.ledger(accountId)
	return {
		account: {
			id: accountId,
			chargesEnabled: Boolean(account.charges_enabled),
			payoutsEnabled: Boolean(account.payouts_enabled),
		},
		charges: toRows(ledger.charges, (item) => String(item.payment_intent)),
		transfers: toRows(ledger.transfers, (item) =>
			String(item.source_transaction),
		),
		fees: toRows(ledger.applicationFees, (item) => String(item.charge)),
		refunds: toRows(ledger.refunds, (item) => String(item.charge)),
		reversals: toRows(ledger.reversals, (item) => String(item.transfer)),
		feeRefunds: toRows(ledger.feeRefunds, (item) => String(item.fee)),
		disputes: toRows(ledger.disputes, (item) => String(item.charge)),
	}
}

function LedgerTable({
	testId,
	title,
	rows,
}: {
	testId: string
	title: React.ReactNode
	rows: Row[]
}) {
	return (
		<Card data-testid={testId}>
			<CardHeader>
				<CardTitle>{title}</CardTitle>
			</CardHeader>
			<CardContent>
				{rows.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>Nothing yet.</Trans>
					</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>
									<Trans>ID</Trans>
								</TableHead>
								<TableHead className="text-end">
									<Trans>Amount</Trans>
								</TableHead>
								<TableHead>
									<Trans>Details</Trans>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map((row) => (
								<TableRow key={row.id} data-testid="mock-ledger-row">
									<TableCell>
										<code>{row.id}</code>
									</TableCell>
									<TableCell className="text-end" data-amount={row.amount}>
										{formatMinor(row.amount, row.currency)}
									</TableCell>
									<TableCell className="text-muted-foreground">
										<code>{row.extra}</code>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</CardContent>
		</Card>
	)
}

export default function MockStripeDashboard() {
	const view = useLoaderData<typeof loader>()
	return (
		<MockPage
			wide
			testId="mock-stripe-dashboard"
			banner={<Trans>Mock Stripe Express dashboard (local)</Trans>}
		>
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Payments</Trans>
					</CardTitle>
					<CardDescription>
						<code data-testid="mock-account-id">{view.account.id}</code>
					</CardDescription>
				</CardHeader>
				<CardContent>
					<p className="text-sm">
						{view.account.chargesEnabled ? (
							<Trans>Charges enabled</Trans>
						) : (
							<Trans>Charges disabled</Trans>
						)}
						{' · '}
						{view.account.payoutsEnabled ? (
							<Trans>Payouts enabled</Trans>
						) : (
							<Trans>Payouts disabled</Trans>
						)}
					</p>
				</CardContent>
			</Card>
			<LedgerTable
				testId="mock-ledger-charges"
				title={<Trans>Charges</Trans>}
				rows={view.charges}
			/>
			<LedgerTable
				testId="mock-ledger-transfers"
				title={<Trans>Transfers</Trans>}
				rows={view.transfers}
			/>
			<LedgerTable
				testId="mock-ledger-fees"
				title={<Trans>Application fees</Trans>}
				rows={view.fees}
			/>
			<LedgerTable
				testId="mock-ledger-refunds"
				title={<Trans>Refunds</Trans>}
				rows={view.refunds}
			/>
			<LedgerTable
				testId="mock-ledger-reversals"
				title={<Trans>Transfer reversals</Trans>}
				rows={view.reversals}
			/>
			<LedgerTable
				testId="mock-ledger-fee-refunds"
				title={<Trans>Application fee refunds</Trans>}
				rows={view.feeRefunds}
			/>
			<LedgerTable
				testId="mock-ledger-disputes"
				title={<Trans>Disputes</Trans>}
				rows={view.disputes}
			/>
		</MockPage>
	)
}
