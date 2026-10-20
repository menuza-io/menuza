import { redirect, type LoaderFunctionArgs } from 'react-router'
import { requirePaymentsMock } from '#app/utils/payments-mock/gate.server.ts'

/** `/mock-payments` is the dashboard. 404 unless the payment mock is on. */
export function loader({ request }: LoaderFunctionArgs) {
	requirePaymentsMock(request)
	return redirect('/mock-payments/dashboard')
}
