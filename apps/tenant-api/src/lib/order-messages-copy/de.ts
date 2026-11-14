import { type OrderMessageCopy } from './types.ts'

export const DE: OrderMessageCopy = {
	kinds: {
		receipt: {
			subject: 'Deine Bestellung {number} bei {r}',
			heading: 'Danke für deine Bestellung',
			lead: 'Wir haben deine Bestellung {number} erhalten. Hier sind die Details.',
		},
		accepted: {
			subject: 'Deine Bestellung {number} wurde angenommen',
			heading: 'Deine Bestellung wurde angenommen',
			lead: '{r} hat deine Bestellung {number} angenommen.',
		},
		ready: {
			subject: 'Deine Bestellung {number} ist fertig',
			heading: 'Deine Bestellung ist fertig',
			lead: 'Deine Bestellung {number} ist zur Abholung bei {location} bereit.',
			leadDelivery: 'Deine Bestellung {number} ist fertig und bald unterwegs.',
		},
		out_for_delivery: {
			subject: 'Deine Bestellung {number} ist unterwegs',
			heading: 'Deine Bestellung ist unterwegs',
			lead: 'Deine Bestellung {number} von {r} wird gerade geliefert.',
		},
		cancelled: {
			subject: 'Deine Bestellung {number} wurde storniert',
			heading: 'Deine Bestellung wurde storniert',
			lead: '{r} hat deine Bestellung {number} storniert. Bei Fragen wende dich bitte an das Restaurant.',
		},
		eta_changed: {
			subject: 'Neue Zeit für deine Bestellung {number}',
			heading: 'Deine Bestellung hat eine neue Zeit',
			lead: '{r} hat die Zeit für deine Bestellung {number} geändert.',
		},
	},
	sms: {
		ready: 'Deine Bestellung {number} bei {r} ist fertig.',
		eta_changed: 'Neue Zeit für deine Bestellung {number} bei {r}: {time}.',
	},
	labels: {
		order: 'Bestellung',
		location: 'Standort',
		items: 'Artikel',
		subtotal: 'Zwischensumme',
		discount: 'Rabatt',
		reward: 'Prämie',
		deliveryFee: 'Liefergebühr',
		tip: 'Trinkgeld',
		tax: 'Steuer',
		total: 'Gesamt',
		refunded: 'Erstattet',
		pickupTime: 'Abholzeit',
		deliveryTime: 'Lieferzeit',
		asap: 'So bald wie möglich',
		readyAround: 'Fertig gegen {time}',
		arriving: 'Ankunft zwischen {from} und {to}',
		arrivingAround: 'Ankunft gegen {time}',
		viewOrder: 'Bestellung ansehen',
		footer: 'Dies ist eine Servicenachricht zu deiner Bestellung.',
	},
}
