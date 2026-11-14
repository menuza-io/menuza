import { type OrderMessageCopy } from './types.ts'

export const AR: OrderMessageCopy = {
	kinds: {
		receipt: {
			subject: 'طلبك {number} من {r}',
			heading: 'شكرًا لطلبك',
			lead: 'استلمنا طلبك {number}. إليك التفاصيل.',
		},
		accepted: {
			subject: 'تم قبول طلبك {number}',
			heading: 'تم قبول طلبك',
			lead: 'قبل {r} طلبك {number}.',
		},
		ready: {
			subject: 'طلبك {number} جاهز',
			heading: 'طلبك جاهز',
			lead: 'طلبك {number} جاهز للاستلام من {location}.',
			leadDelivery: 'طلبك {number} جاهز وسيكون في الطريق إليك قريبًا.',
		},
		out_for_delivery: {
			subject: 'طلبك {number} في الطريق',
			heading: 'طلبك في الطريق',
			lead: 'طلبك {number} من {r} في الطريق إليك.',
		},
		cancelled: {
			subject: 'تم إلغاء طلبك {number}',
			heading: 'تم إلغاء طلبك',
			lead: 'ألغى {r} طلبك {number}. إذا كانت لديك أسئلة، يرجى التواصل مع المطعم.',
		},
		eta_changed: {
			subject: 'موعد جديد لطلبك {number}',
			heading: 'لطلبك موعد جديد',
			lead: 'حدّث {r} موعد طلبك {number}.',
		},
	},
	sms: {
		ready: 'طلبك {number} من {r} جاهز.',
		eta_changed: 'موعد جديد لطلبك {number} من {r}: {time}.',
	},
	labels: {
		order: 'الطلب',
		location: 'الفرع',
		items: 'الأصناف',
		subtotal: 'المجموع الفرعي',
		discount: 'الخصم',
		reward: 'المكافأة',
		deliveryFee: 'رسوم التوصيل',
		tip: 'الإكرامية',
		tax: 'الضريبة',
		total: 'الإجمالي',
		refunded: 'المبلغ المسترد',
		pickupTime: 'وقت الاستلام',
		deliveryTime: 'وقت التوصيل',
		asap: 'في أقرب وقت ممكن',
		readyAround: 'جاهز نحو {time}',
		arriving: 'يصل بين {from} و{to}',
		arrivingAround: 'يصل نحو {time}',
		viewOrder: 'عرض طلبك',
		footer: 'هذه رسالة خدمة بخصوص طلبك.',
	},
}
