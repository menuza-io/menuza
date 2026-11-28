import { type ReservationEmailLocale } from './reservations-email.ts'

/**
 * The words of the answer a restaurant gives to a guest's order problem report
 * (#191), for the email and the text. Shipped copy, never authored by an
 * operator; the operator's own message (when there is one) is added as a quote.
 * Placeholders: `{number}` order number, `{r}` restaurant, `{amount}` money,
 * `{code}` credit code, `{date}` credit expiry.
 */
export type OrderProblemCopy = {
	subject: string
	heading: string
	refund: string
	credit: string
	creditCode: string
	creditUntil: string
	reply: string
	closed: string
	messageLabel: string
	viewOrder: string
	useCredit: string
	footer: string
	sms: { refund: string; credit: string; reply: string; closed: string }
}

const en: OrderProblemCopy = {
	subject: 'About your order {number} from {r}',
	heading: 'We read your report',
	refund: '{r} refunded {amount} for order {number}.',
	credit:
		'{r} gave you a credit of {amount} for your next order. It works once.',
	creditCode: 'Your code',
	creditUntil: 'Use it before {date}.',
	reply: '{r} replied about order {number}.',
	closed: '{r} closed your report about order {number}.',
	messageLabel: 'Their message',
	viewOrder: 'View your order',
	useCredit: 'Order now with your credit',
	footer: 'You get this because you reported a problem with this order.',
	sms: {
		refund: '{r}: refunded {amount} for order {number}.',
		credit: '{r}: your credit {code} ({amount}) works on your next order.',
		reply: '{r} replied about order {number}.',
		closed: '{r} closed your report about order {number}.',
	},
}

const ar: OrderProblemCopy = {
	subject: 'بخصوص طلبك {number} من {r}',
	heading: 'قرأنا بلاغك',
	refund: 'قام {r} برد {amount} للطلب {number}.',
	credit: 'منحك {r} رصيدًا بقيمة {amount} لطلبك القادم. يُستخدم مرة واحدة.',
	creditCode: 'رمزك',
	creditUntil: 'استخدمه قبل {date}.',
	reply: 'ردّ {r} بخصوص الطلب {number}.',
	closed: 'أغلق {r} بلاغك بخصوص الطلب {number}.',
	messageLabel: 'رسالتهم',
	viewOrder: 'عرض طلبك',
	useCredit: 'اطلب الآن برصيدك',
	footer: 'وصلتك هذه الرسالة لأنك أبلغت عن مشكلة في هذا الطلب.',
	sms: {
		refund: '{r}: تم رد {amount} للطلب {number}.',
		credit: '{r}: رصيدك {code} ({amount}) يعمل على طلبك القادم.',
		reply: 'ردّ {r} بخصوص الطلب {number}.',
		closed: 'أغلق {r} بلاغك بخصوص الطلب {number}.',
	},
}

const es: OrderProblemCopy = {
	subject: 'Sobre tu pedido {number} de {r}',
	heading: 'Hemos leído tu aviso',
	refund: '{r} te reembolsó {amount} por el pedido {number}.',
	credit:
		'{r} te dio un crédito de {amount} para tu próximo pedido. Se usa una vez.',
	creditCode: 'Tu código',
	creditUntil: 'Úsalo antes del {date}.',
	reply: '{r} respondió sobre el pedido {number}.',
	closed: '{r} cerró tu aviso sobre el pedido {number}.',
	messageLabel: 'Su mensaje',
	viewOrder: 'Ver tu pedido',
	useCredit: 'Pide ahora con tu crédito',
	footer: 'Recibes esto porque avisaste de un problema con este pedido.',
	sms: {
		refund: '{r}: reembolso de {amount} por el pedido {number}.',
		credit: '{r}: tu crédito {code} ({amount}) sirve en tu próximo pedido.',
		reply: '{r} respondió sobre el pedido {number}.',
		closed: '{r} cerró tu aviso sobre el pedido {number}.',
	},
}

const fr: OrderProblemCopy = {
	subject: 'À propos de votre commande {number} chez {r}',
	heading: 'Nous avons lu votre signalement',
	refund: '{r} vous a remboursé {amount} pour la commande {number}.',
	credit:
		'{r} vous offre un avoir de {amount} pour votre prochaine commande. Il sert une fois.',
	creditCode: 'Votre code',
	creditUntil: 'Utilisez-le avant le {date}.',
	reply: '{r} a répondu au sujet de la commande {number}.',
	closed: '{r} a clos votre signalement sur la commande {number}.',
	messageLabel: 'Son message',
	viewOrder: 'Voir votre commande',
	useCredit: 'Commander avec votre avoir',
	footer:
		'Vous recevez ce message car vous avez signalé un problème sur cette commande.',
	sms: {
		refund: '{r} : {amount} remboursés pour la commande {number}.',
		credit:
			'{r} : votre avoir {code} ({amount}) vaut pour votre prochaine commande.',
		reply: '{r} a répondu au sujet de la commande {number}.',
		closed: '{r} a clos votre signalement sur la commande {number}.',
	},
}

const de: OrderProblemCopy = {
	subject: 'Zu Ihrer Bestellung {number} bei {r}',
	heading: 'Wir haben Ihre Meldung gelesen',
	refund: '{r} hat {amount} für die Bestellung {number} erstattet.',
	credit:
		'{r} schenkt Ihnen ein Guthaben von {amount} für Ihre nächste Bestellung. Es gilt einmal.',
	creditCode: 'Ihr Code',
	creditUntil: 'Lösen Sie ihn vor dem {date} ein.',
	reply: '{r} hat zur Bestellung {number} geantwortet.',
	closed: '{r} hat Ihre Meldung zur Bestellung {number} abgeschlossen.',
	messageLabel: 'Die Nachricht',
	viewOrder: 'Bestellung ansehen',
	useCredit: 'Jetzt mit Ihrem Guthaben bestellen',
	footer:
		'Sie erhalten dies, weil Sie ein Problem mit dieser Bestellung gemeldet haben.',
	sms: {
		refund: '{r}: {amount} für Bestellung {number} erstattet.',
		credit:
			'{r}: Ihr Guthaben {code} ({amount}) gilt für Ihre nächste Bestellung.',
		reply: '{r} hat zur Bestellung {number} geantwortet.',
		closed: '{r} hat Ihre Meldung zur Bestellung {number} abgeschlossen.',
	},
}

const zh: OrderProblemCopy = {
	subject: '关于您在{r}的订单 {number}',
	heading: '我们已阅读您的反馈',
	refund: '{r}已就订单 {number} 退款 {amount}。',
	credit: '{r}送您 {amount} 的优惠额度，用于下一单，仅限使用一次。',
	creditCode: '您的优惠码',
	creditUntil: '请在 {date} 前使用。',
	reply: '{r}已回复订单 {number} 的反馈。',
	closed: '{r}已关闭您对订单 {number} 的反馈。',
	messageLabel: '对方留言',
	viewOrder: '查看订单',
	useCredit: '使用优惠额度下单',
	footer: '您收到此消息，是因为您反馈了这笔订单的问题。',
	sms: {
		refund: '{r}：订单 {number} 已退款 {amount}。',
		credit: '{r}：您的优惠码 {code}（{amount}）可用于下一单。',
		reply: '{r}已回复订单 {number} 的反馈。',
		closed: '{r}已关闭您对订单 {number} 的反馈。',
	},
}

const COPY: Record<ReservationEmailLocale, OrderProblemCopy> = {
	en,
	ar,
	es,
	fr,
	de,
	zh,
}

export function orderProblemCopyFor(
	locale: ReservationEmailLocale,
): OrderProblemCopy {
	return COPY[locale] ?? en
}
