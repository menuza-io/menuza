import { type OrderMessageCopy } from './types.ts'

export const ES: OrderMessageCopy = {
	kinds: {
		receipt: {
			subject: 'Tu pedido {number} de {r}',
			heading: 'Gracias por tu pedido',
			lead: 'Recibimos tu pedido {number}. Estos son los detalles.',
		},
		accepted: {
			subject: 'Tu pedido {number} fue aceptado',
			heading: 'Tu pedido fue aceptado',
			lead: '{r} aceptó tu pedido {number}.',
		},
		ready: {
			subject: 'Tu pedido {number} está listo',
			heading: 'Tu pedido está listo',
			lead: 'Tu pedido {number} está listo para recoger en {location}.',
			leadDelivery: 'Tu pedido {number} está listo y saldrá pronto hacia ti.',
		},
		out_for_delivery: {
			subject: 'Tu pedido {number} va en camino',
			heading: 'Tu pedido va en camino',
			lead: 'Tu pedido {number} de {r} está en reparto.',
		},
		cancelled: {
			subject: 'Tu pedido {number} fue cancelado',
			heading: 'Tu pedido fue cancelado',
			lead: '{r} canceló tu pedido {number}. Si tienes preguntas, contacta con el restaurante.',
		},
		eta_changed: {
			subject: 'Nueva hora para tu pedido {number}',
			heading: 'Tu pedido tiene una nueva hora',
			lead: '{r} actualizó la hora de tu pedido {number}.',
		},
	},
	sms: {
		ready: 'Tu pedido {number} de {r} está listo.',
		eta_changed: 'Nueva hora para tu pedido {number} de {r}: {time}.',
	},
	labels: {
		order: 'Pedido',
		location: 'Local',
		items: 'Artículos',
		subtotal: 'Subtotal',
		discount: 'Descuento',
		reward: 'Recompensa',
		deliveryFee: 'Gastos de envío',
		tip: 'Propina',
		tax: 'Impuestos',
		total: 'Total',
		refunded: 'Reembolsado',
		pickupTime: 'Hora de recogida',
		deliveryTime: 'Hora de entrega',
		asap: 'Lo antes posible',
		readyAround: 'Listo hacia las {time}',
		arriving: 'Llega entre {from} y {to}',
		arrivingAround: 'Llega hacia las {time}',
		viewOrder: 'Ver tu pedido',
		footer: 'Este es un mensaje de servicio sobre tu pedido.',
	},
}
