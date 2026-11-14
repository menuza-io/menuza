import { type OrderMessageCopy } from './types.ts'

export const FR: OrderMessageCopy = {
	kinds: {
		receipt: {
			subject: 'Votre commande {number} chez {r}',
			heading: 'Merci pour votre commande',
			lead: 'Nous avons bien reçu votre commande {number}. En voici le détail.',
		},
		accepted: {
			subject: 'Votre commande {number} a été acceptée',
			heading: 'Votre commande a été acceptée',
			lead: '{r} a accepté votre commande {number}.',
		},
		ready: {
			subject: 'Votre commande {number} est prête',
			heading: 'Votre commande est prête',
			lead: 'Votre commande {number} est prête à être retirée à {location}.',
			leadDelivery: 'Votre commande {number} est prête et partira bientôt.',
		},
		out_for_delivery: {
			subject: 'Votre commande {number} est en route',
			heading: 'Votre commande est en route',
			lead: 'Votre commande {number} de {r} est en cours de livraison.',
		},
		cancelled: {
			subject: 'Votre commande {number} a été annulée',
			heading: 'Votre commande a été annulée',
			lead: '{r} a annulé votre commande {number}. Pour toute question, contactez le restaurant.',
		},
		eta_changed: {
			subject: 'Nouvel horaire pour votre commande {number}',
			heading: 'Votre commande a un nouvel horaire',
			lead: '{r} a mis à jour l’horaire de votre commande {number}.',
		},
	},
	sms: {
		ready: 'Votre commande {number} chez {r} est prête.',
		eta_changed:
			'Nouvel horaire pour votre commande {number} chez {r} : {time}.',
	},
	labels: {
		order: 'Commande',
		location: 'Établissement',
		items: 'Articles',
		subtotal: 'Sous-total',
		discount: 'Remise',
		reward: 'Récompense',
		deliveryFee: 'Frais de livraison',
		tip: 'Pourboire',
		tax: 'Taxes',
		total: 'Total',
		refunded: 'Remboursé',
		pickupTime: 'Heure de retrait',
		deliveryTime: 'Heure de livraison',
		asap: 'Dès que possible',
		readyAround: 'Prête vers {time}',
		arriving: 'Arrivée entre {from} et {to}',
		arrivingAround: 'Arrivée vers {time}',
		viewOrder: 'Voir votre commande',
		footer: 'Ceci est un message de service concernant votre commande.',
	},
}
