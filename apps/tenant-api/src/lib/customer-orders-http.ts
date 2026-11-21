/**
 * What every refused read of an order answers: byte for byte the same body for
 * an order that does not exist and one that belongs to another guest (#112).
 */
export function orderNotFoundBody() {
	return { error: 'order_not_found', message: 'Order not found.' }
}
