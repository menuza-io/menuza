/**
 * The mistake the production guard exists for: a panel gated only by a runtime
 * flag, so its link to the mock dashboard survives a build with the define
 * false.
 */
export function ungatedPanelLink(paymentsMock?: { enabled: boolean }) {
	return paymentsMock?.enabled
		? { testId: 'mock-payments-panel', href: '/mock-payments/dashboard' }
		: null
}
