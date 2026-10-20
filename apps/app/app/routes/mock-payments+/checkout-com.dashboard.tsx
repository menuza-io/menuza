import { Trans } from '@lingui/macro'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
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
import {
	Form,
	redirect,
	useLoaderData,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { z } from 'zod'
import { getPaymentsEmulator } from '#app/utils/payments-mock/emulator.server.ts'
import { requirePaymentsMock } from '#app/utils/payments-mock/gate.server.ts'
import { formatMinor, MockPage } from './__mock-page.tsx'

/** "Open Checkout dashboard" in mock mode: `/mock-payments/checkout-com/dashboard`. */
export async function loader({ request }: LoaderFunctionArgs) {
	requirePaymentsMock(request, 'checkout')
	const snapshot = await getPaymentsEmulator().pages.checkout.dashboard()
	return {
		entities: snapshot.entities.map((entity) => ({
			id: String(entity.id),
			status: String(entity.status),
			paymentsEnabled: Boolean(entity.capabilities?.payments?.enabled),
			payoutsEnabled: Boolean(entity.capabilities?.payouts?.enabled),
		})),
		payments: snapshot.payments.map((payment) => ({
			id: String(payment.id),
			status: String(payment.status),
			amount: Number(payment.amount),
			currency: String(payment.currency),
			approved: Boolean(payment.approved),
			responseCode: String(payment.response_code ?? ''),
			allocations: (
				(payment.amount_allocations ?? []) as Array<{
					id: string
					amount: number
					commission: { amount: number }
				}>
			).map((allocation) => ({
				id: allocation.id,
				amount: allocation.amount,
				commission: allocation.commission.amount,
			})),
		})),
	}
}

const intentSchema = z.object({
	intent: z.enum(['activate-payments', 'activate-payouts']),
	entityId: z.string().trim().min(1).max(80),
})

export async function action({ request }: ActionFunctionArgs) {
	requirePaymentsMock(request, 'checkout')
	const parsed = intentSchema.safeParse(
		Object.fromEntries(await request.formData()),
	)
	if (!parsed.success) throw new Response('Bad Request', { status: 400 })
	const activation =
		parsed.data.intent === 'activate-payments'
			? { payments: true }
			: { payouts: true }
	try {
		await getPaymentsEmulator().pages.checkout.activate(
			parsed.data.entityId,
			activation,
		)
	} catch {
		throw new Response('Not Found', { status: 404 })
	}
	return redirect('/mock-payments/checkout-com/dashboard')
}

export default function MockCheckoutDashboard() {
	const view = useLoaderData<typeof loader>()
	return (
		<MockPage
			wide
			testId="mock-checkout-dashboard"
			banner={<Trans>Mock Checkout.com dashboard (local)</Trans>}
		>
			<Card data-testid="mock-cko-entities">
				<CardHeader>
					<CardTitle>
						<Trans>Sub-entities</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Activate a sub-entity to let it take payments and receive payouts.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent>
					{view.entities.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							<Trans>No sub-entities yet.</Trans>
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>Entity</Trans>
									</TableHead>
									<TableHead>
										<Trans>Status</Trans>
									</TableHead>
									<TableHead>
										<Trans>Payments</Trans>
									</TableHead>
									<TableHead>
										<Trans>Payouts</Trans>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{view.entities.map((entity) => (
									<TableRow key={entity.id} data-testid="mock-cko-entity">
										<TableCell>
											<code>{entity.id}</code>
										</TableCell>
										<TableCell>
											<Badge variant="outline">{entity.status}</Badge>
										</TableCell>
										<TableCell>
											{entity.paymentsEnabled ? (
												<Badge>
													<Trans>Enabled</Trans>
												</Badge>
											) : (
												<Form method="post" reloadDocument>
													<input
														type="hidden"
														name="intent"
														value="activate-payments"
													/>
													<input
														type="hidden"
														name="entityId"
														value={entity.id}
													/>
													<Button
														type="submit"
														size="sm"
														data-testid="mock-cko-activate-payments"
													>
														<Trans>Activate payments</Trans>
													</Button>
												</Form>
											)}
										</TableCell>
										<TableCell>
											{entity.payoutsEnabled ? (
												<Badge>
													<Trans>Enabled</Trans>
												</Badge>
											) : (
												<Form method="post" reloadDocument>
													<input
														type="hidden"
														name="intent"
														value="activate-payouts"
													/>
													<input
														type="hidden"
														name="entityId"
														value={entity.id}
													/>
													<Button
														type="submit"
														size="sm"
														variant="outline"
														data-testid="mock-cko-activate-payouts"
													>
														<Trans>Activate payouts</Trans>
													</Button>
												</Form>
											)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>
			<Card data-testid="mock-cko-payments">
				<CardHeader>
					<CardTitle>
						<Trans>Payments</Trans>
					</CardTitle>
				</CardHeader>
				<CardContent>
					{view.payments.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							<Trans>No payments yet.</Trans>
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>Payment</Trans>
									</TableHead>
									<TableHead>
										<Trans>Status</Trans>
									</TableHead>
									<TableHead className="text-end">
										<Trans>Amount</Trans>
									</TableHead>
									<TableHead>
										<Trans>Allocation</Trans>
									</TableHead>
									<TableHead className="text-end">
										<Trans>Commission</Trans>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{view.payments.map((payment) => (
									<TableRow key={payment.id} data-testid="mock-cko-payment">
										<TableCell>
											<code>{payment.id}</code>
										</TableCell>
										<TableCell>
											<Badge
												variant={payment.approved ? 'default' : 'secondary'}
											>
												{payment.status}
											</Badge>
											{!payment.approved ? (
												<code className="ms-2">{payment.responseCode}</code>
											) : null}
										</TableCell>
										<TableCell className="text-end">
											{formatMinor(payment.amount, payment.currency)}
										</TableCell>
										<TableCell>
											{payment.allocations.map((allocation) => (
												<div key={allocation.id}>
													<code>{allocation.id}</code>{' '}
													{formatMinor(allocation.amount, payment.currency)}
												</div>
											))}
										</TableCell>
										<TableCell className="text-end">
											{payment.allocations.map((allocation) => (
												<div key={allocation.id}>
													{formatMinor(allocation.commission, payment.currency)}
												</div>
											))}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>
		</MockPage>
	)
}
