import { Trans } from '@lingui/macro'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Form, Link } from 'react-router'

export type PaymentsMockUiState = {
	enabled: boolean
	stripe: boolean
	checkout: boolean
}

/**
 * Dev and CI only: the loader sends `enabled: false` in every production
 * build, so this panel never renders there. The instant buttons run the same
 * account setup and status sync the real onboarding return runs.
 */
export function MockPaymentsPanel({ state }: { state: PaymentsMockUiState }) {
	return (
		<Alert data-testid="mock-payments-panel">
			<AlertTitle>
				<Trans>Mock payments</Trans>
			</AlertTitle>
			<AlertDescription>
				<p>
					<Trans>
						Provider calls go to the built-in emulators. No real money moves and
						no real keys are used.
					</Trans>
				</p>
				<div className="flex flex-wrap gap-3">
					{state.stripe ? (
						<Form method="post">
							<input type="hidden" name="intent" value="mock-onboard-stripe" />
							<Button
								type="submit"
								variant="outline"
								data-testid="mock-onboard-stripe"
							>
								<Trans>Instantly enable Stripe (mock)</Trans>
							</Button>
						</Form>
					) : null}
					{state.checkout ? (
						<Form method="post">
							<input
								type="hidden"
								name="intent"
								value="mock-onboard-checkout"
							/>
							<Button
								type="submit"
								variant="outline"
								data-testid="mock-onboard-checkout"
							>
								<Trans>Instantly enable Checkout.com (mock)</Trans>
							</Button>
						</Form>
					) : null}
					<Button
						variant="ghost"
						render={<Link to="/mock-payments/dashboard" reloadDocument />}
						nativeButton={false}
					>
						<Trans>Open mock payments dashboard</Trans>
					</Button>
				</div>
			</AlertDescription>
		</Alert>
	)
}
