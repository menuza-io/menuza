import { requireUserId } from '@repo/auth'
import { handleStripeCheckout } from '@repo/payments'
import { type LoaderFunctionArgs } from 'react-router'
import { stripe } from '#app/utils/payments.server.ts'

export async function loader(args: LoaderFunctionArgs) {
	const userId = await requireUserId(args.request)
	return handleStripeCheckout(args, {
		stripe,
		userId,
	})
}

export default function CheckoutPage() {
	return <div>Checkout</div>
}
