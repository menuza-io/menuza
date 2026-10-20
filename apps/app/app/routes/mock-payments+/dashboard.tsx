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
	Link,
	redirect,
	useLoaderData,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { z } from 'zod'
import { getPaymentsEmulator } from '#app/utils/payments-mock/emulator.server.ts'
import { toEventSummary } from '#app/utils/payments-mock/events.server.ts'
import { requirePaymentsMock } from '#app/utils/payments-mock/gate.server.ts'
import { MockPage } from './__mock-page.tsx'

/** `/mock-payments/dashboard`: where the mock pages start, plus the event log. */
export async function loader({ request }: LoaderFunctionArgs) {
	const status = requirePaymentsMock(request)
	const events = await getPaymentsEmulator().events.list({ limit: 100 })
	return {
		status,
		webhookMode: process.env.PAYMENTS_MOCK_WEBHOOKS || 'inline',
		events: events.map((event) => toEventSummary(event, false)),
	}
}

const intentSchema = z.discriminatedUnion('intent', [
	z.object({ intent: z.literal('flush') }),
	z.object({
		intent: z.literal('redeliver'),
		eventId: z.string().trim().min(1).max(80),
		provider: z.enum(['stripe', 'checkout']),
	}),
])

export async function action({ request }: ActionFunctionArgs) {
	requirePaymentsMock(request)
	const parsed = intentSchema.safeParse(
		Object.fromEntries(await request.formData()),
	)
	if (!parsed.success) throw new Response('Bad Request', { status: 400 })
	const emulator = getPaymentsEmulator()
	if (parsed.data.intent === 'flush') {
		await emulator.events.flush()
	} else {
		const event = await emulator.events.redeliver(
			parsed.data.provider,
			parsed.data.eventId,
		)
		if (!event) throw new Response('Not Found', { status: 404 })
	}
	return redirect('/mock-payments/dashboard')
}

export default function MockPaymentsDashboard() {
	const { status, webhookMode, events } = useLoaderData<typeof loader>()
	return (
		<MockPage
			wide
			testId="mock-payments-dashboard"
			banner={<Trans>Mock payments (local)</Trans>}
		>
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Payment mock</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Stripe and Checkout.com are emulated in this app. Nothing here is
							real.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-wrap items-center gap-3">
					<Badge variant={status.stripe ? 'default' : 'secondary'}>
						{status.stripe ? (
							<Trans>Stripe: mocked</Trans>
						) : (
							<Trans>Stripe: real</Trans>
						)}
					</Badge>
					<Badge variant={status.checkout ? 'default' : 'secondary'}>
						{status.checkout ? (
							<Trans>Checkout.com: mocked</Trans>
						) : (
							<Trans>Checkout.com: real</Trans>
						)}
					</Badge>
					<Badge variant="outline" data-testid="mock-webhook-mode">
						<Trans>Webhooks: {webhookMode}</Trans>
					</Badge>
					{status.checkout ? (
						<Button
							variant="outline"
							size="sm"
							render={<Link to="/mock-payments/checkout-com/dashboard" />}
							nativeButton={false}
						>
							<Trans>Checkout.com dashboard</Trans>
						</Button>
					) : null}
				</CardContent>
			</Card>
			<Card data-testid="mock-event-log">
				<CardHeader>
					<CardTitle>
						<Trans>Event log</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>Signed webhook deliveries, newest first.</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<Form method="post" reloadDocument>
						<input type="hidden" name="intent" value="flush" />
						<Button
							type="submit"
							variant="outline"
							size="sm"
							data-testid="mock-flush"
						>
							<Trans>Deliver queued events</Trans>
						</Button>
					</Form>
					{events.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							<Trans>No events yet.</Trans>
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>Provider</Trans>
									</TableHead>
									<TableHead>
										<Trans>Type</Trans>
									</TableHead>
									<TableHead>
										<Trans>Delivery</Trans>
									</TableHead>
									<TableHead className="text-end">
										<Trans>Attempts</Trans>
									</TableHead>
									<TableHead />
								</TableRow>
							</TableHeader>
							<TableBody>
								{events.map((event) => {
									const lastStatus = event.last_status
									return (
										<TableRow
											key={event.id}
											data-testid="mock-event-row"
											data-event-id={event.id}
										>
											<TableCell>{event.provider}</TableCell>
											<TableCell>
												<code>{event.type}</code>
											</TableCell>
											<TableCell data-testid="mock-event-status">
												{event.delivered_at ? (
													<Badge>
														<Trans>Delivered ({lastStatus})</Trans>
													</Badge>
												) : event.attempts > 0 ? (
													<Badge variant="destructive">
														<Trans>Failed ({lastStatus})</Trans>
													</Badge>
												) : (
													<Badge variant="secondary">
														<Trans>Queued</Trans>
													</Badge>
												)}
											</TableCell>
											<TableCell
												className="text-end"
												data-testid="mock-event-attempts"
											>
												{event.attempts}
											</TableCell>
											<TableCell className="text-end">
												<Form method="post" reloadDocument>
													<input
														type="hidden"
														name="intent"
														value="redeliver"
													/>
													<input
														type="hidden"
														name="eventId"
														value={event.id}
													/>
													<input
														type="hidden"
														name="provider"
														value={event.provider}
													/>
													<Button
														type="submit"
														size="sm"
														variant="outline"
														data-testid="mock-redeliver"
													>
														<Trans>Redeliver</Trans>
													</Button>
												</Form>
											</TableCell>
										</TableRow>
									)
								})}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>
		</MockPage>
	)
}
