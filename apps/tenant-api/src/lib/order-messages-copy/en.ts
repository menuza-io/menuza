import { type OrderMessageCopy } from './types.ts'

export const EN: OrderMessageCopy = {
	kinds: {
		receipt: {
			subject: 'Your order {number} from {r}',
			heading: 'Thanks for your order',
			lead: 'We received your order {number}. Here are the details.',
		},
		accepted: {
			subject: 'Your order {number} was accepted',
			heading: 'Your order was accepted',
			lead: '{r} accepted your order {number}.',
		},
		ready: {
			subject: 'Your order {number} is ready',
			heading: 'Your order is ready',
			lead: 'Your order {number} is ready for pickup at {location}.',
			leadDelivery: 'Your order {number} is ready and will be on its way soon.',
		},
		out_for_delivery: {
			subject: 'Your order {number} is on its way',
			heading: 'Your order is on its way',
			lead: 'Your order {number} from {r} is out for delivery.',
		},
		cancelled: {
			subject: 'Your order {number} was cancelled',
			heading: 'Your order was cancelled',
			lead: '{r} cancelled your order {number}. If you have questions, please contact the restaurant.',
		},
		eta_changed: {
			subject: 'New time for your order {number}',
			heading: 'Your order has a new time',
			lead: '{r} updated the time for your order {number}.',
		},
	},
	sms: {
		ready: 'Your order {number} from {r} is ready.',
		eta_changed: 'New time for your order {number} from {r}: {time}.',
	},
	labels: {
		order: 'Order',
		location: 'Location',
		items: 'Items',
		subtotal: 'Subtotal',
		discount: 'Discount',
		reward: 'Reward',
		deliveryFee: 'Delivery fee',
		tip: 'Tip',
		tax: 'Tax',
		total: 'Total',
		refunded: 'Refunded',
		pickupTime: 'Pickup time',
		deliveryTime: 'Delivery time',
		asap: 'As soon as possible',
		readyAround: 'Ready around {time}',
		arriving: 'Arriving {from} to {to}',
		arrivingAround: 'Arriving around {time}',
		viewOrder: 'View your order',
		footer: 'This is a service message about your order.',
	},
}
