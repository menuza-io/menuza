import { type SiteContentLocale } from '@repo/common/site-locales'

/**
 * Gift card email copy for every site language. Placeholders: `{r}` (the
 * restaurant), `{from}`, `{to}`. Transactional only: no marketing content.
 */
export type GiftCardCopy = {
	receipt: { subject: string; heading: string; lead: string; leadLater: string; leadHeld: string }
	delivery: { subject: string; subjectSelf: string; heading: string; lead: string; leadSelf: string }
	labels: {
		amount: string
		code: string
		from: string
		message: string
		checkBalance: string
		orderNow: string
		addToAccount: string
		deliversOn: string
		fee: string
		total: string
		expires: string
		to: string
		keepSafe: string
	}
	/** The headline over each design. */
	designs: Record<
		'classic' | 'birthday' | 'holidays' | 'thank_you' | 'eid' | 'ramadan' | 'national_day' | 'custom',
		string
	>
}

const en: GiftCardCopy = {
	receipt: {
		subject: 'Your gift card purchase from {r}',
		heading: 'Thank you for your gift card',
		lead: 'Your payment went through and the gift card is on its way.',
		leadLater: 'Your payment went through. We will deliver the gift card on the date you chose.',
		leadHeld: 'Your payment went through. Your card will be delivered within 2 hours.',
	},
	delivery: {
		subject: '{from} sent you a gift card for {r}',
		subjectSelf: 'Your gift card for {r}',
		heading: 'A gift card for you',
		lead: '{from} sent you a gift card for {r}.',
		leadSelf: 'Here is your gift card for {r}.',
	},
	labels: {
		amount: 'Amount',
		code: 'Card code',
		from: 'From',
		message: 'Message',
		checkBalance: 'Check balance',
		orderNow: 'Order now',
		addToAccount: 'Add to my account',
		deliversOn: 'Delivery date',
		fee: 'Processing fee',
		total: 'Total paid',
		expires: 'Valid until',
		to: 'To',
		keepSafe: 'Keep this email: anyone with the code can spend the card.',
	},
	designs: {
		classic: 'Gift card',
		birthday: 'Happy birthday',
		holidays: 'Happy holidays',
		thank_you: 'Thank you',
		eid: 'Eid Mubarak',
		ramadan: 'Ramadan Kareem',
		national_day: 'Happy National Day',
		custom: 'Gift card',
	},
}

const ar: GiftCardCopy = {
	receipt: {
		subject: 'عملية شراء بطاقة الهدايا من {r}',
		heading: 'شكرًا لشرائك بطاقة هدايا',
		lead: 'تمت عملية الدفع وبطاقة الهدايا في طريقها.',
		leadLater: 'تمت عملية الدفع. سنرسل بطاقة الهدايا في التاريخ الذي اخترته.',
		leadHeld: 'تمت عملية الدفع. ستصل بطاقتك خلال ساعتين.',
	},
	delivery: {
		subject: 'أرسل لك {from} بطاقة هدايا من {r}',
		subjectSelf: 'بطاقة الهدايا الخاصة بك من {r}',
		heading: 'بطاقة هدايا لك',
		lead: 'أرسل لك {from} بطاقة هدايا من {r}.',
		leadSelf: 'هذه بطاقة الهدايا الخاصة بك من {r}.',
	},
	labels: {
		amount: 'المبلغ',
		code: 'رمز البطاقة',
		from: 'من',
		message: 'الرسالة',
		checkBalance: 'تحقق من الرصيد',
		orderNow: 'اطلب الآن',
		addToAccount: 'أضفها إلى حسابي',
		deliversOn: 'تاريخ التسليم',
		fee: 'رسوم المعالجة',
		total: 'الإجمالي المدفوع',
		expires: 'صالحة حتى',
		to: 'إلى',
		keepSafe: 'احتفظ بهذه الرسالة: يمكن لأي شخص لديه الرمز استخدام البطاقة.',
	},
	designs: {
		classic: 'بطاقة هدايا',
		birthday: 'عيد ميلاد سعيد',
		holidays: 'أعياد سعيدة',
		thank_you: 'شكرًا لك',
		eid: 'عيد مبارك',
		ramadan: 'رمضان كريم',
		national_day: 'يوم وطني سعيد',
		custom: 'بطاقة هدايا',
	},
}

const es: GiftCardCopy = {
	receipt: {
		subject: 'Tu compra de tarjeta regalo en {r}',
		heading: 'Gracias por tu tarjeta regalo',
		lead: 'Tu pago se completó y la tarjeta regalo está en camino.',
		leadLater: 'Tu pago se completó. Entregaremos la tarjeta regalo en la fecha que elegiste.',
		leadHeld: 'Tu pago se completó. Tu tarjeta se entregará en un plazo de 2 horas.',
	},
	delivery: {
		subject: '{from} te envió una tarjeta regalo de {r}',
		subjectSelf: 'Tu tarjeta regalo de {r}',
		heading: 'Una tarjeta regalo para ti',
		lead: '{from} te envió una tarjeta regalo de {r}.',
		leadSelf: 'Aquí está tu tarjeta regalo de {r}.',
	},
	labels: {
		amount: 'Importe',
		code: 'Código de la tarjeta',
		from: 'De',
		message: 'Mensaje',
		checkBalance: 'Consultar saldo',
		orderNow: 'Pedir ahora',
		addToAccount: 'Añadir a mi cuenta',
		deliversOn: 'Fecha de entrega',
		fee: 'Comisión de procesamiento',
		total: 'Total pagado',
		expires: 'Válida hasta',
		to: 'Para',
		keepSafe: 'Guarda este correo: cualquiera con el código puede usar la tarjeta.',
	},
	designs: {
		classic: 'Tarjeta regalo',
		birthday: 'Feliz cumpleaños',
		holidays: 'Felices fiestas',
		thank_you: 'Gracias',
		eid: 'Eid Mubarak',
		ramadan: 'Ramadán Kareem',
		national_day: 'Feliz Día Nacional',
		custom: 'Tarjeta regalo',
	},
}

const fr: GiftCardCopy = {
	receipt: {
		subject: 'Votre achat de carte cadeau chez {r}',
		heading: 'Merci pour votre carte cadeau',
		lead: 'Votre paiement est passé et la carte cadeau est en route.',
		leadLater: 'Votre paiement est passé. Nous enverrons la carte cadeau à la date choisie.',
		leadHeld: 'Votre paiement est passé. Votre carte sera livrée sous 2 heures.',
	},
	delivery: {
		subject: '{from} vous offre une carte cadeau {r}',
		subjectSelf: 'Votre carte cadeau {r}',
		heading: 'Une carte cadeau pour vous',
		lead: '{from} vous a envoyé une carte cadeau pour {r}.',
		leadSelf: 'Voici votre carte cadeau pour {r}.',
	},
	labels: {
		amount: 'Montant',
		code: 'Code de la carte',
		from: 'De la part de',
		message: 'Message',
		checkBalance: 'Consulter le solde',
		orderNow: 'Commander',
		addToAccount: 'Ajouter à mon compte',
		deliversOn: 'Date de livraison',
		fee: 'Frais de traitement',
		total: 'Total payé',
		expires: "Valable jusqu'au",
		to: 'Pour',
		keepSafe: 'Conservez cet e-mail : toute personne ayant le code peut utiliser la carte.',
	},
	designs: {
		classic: 'Carte cadeau',
		birthday: 'Joyeux anniversaire',
		holidays: 'Joyeuses fêtes',
		thank_you: 'Merci',
		eid: 'Eid Mubarak',
		ramadan: 'Ramadan Kareem',
		national_day: 'Bonne fête nationale',
		custom: 'Carte cadeau',
	},
}

const de: GiftCardCopy = {
	receipt: {
		subject: 'Ihr Geschenkgutschein-Kauf bei {r}',
		heading: 'Danke für Ihren Geschenkgutschein',
		lead: 'Ihre Zahlung ist durchgegangen und der Gutschein ist unterwegs.',
		leadLater: 'Ihre Zahlung ist durchgegangen. Wir senden den Gutschein am gewählten Datum.',
		leadHeld: 'Ihre Zahlung ist durchgegangen. Ihr Gutschein wird innerhalb von 2 Stunden zugestellt.',
	},
	delivery: {
		subject: '{from} schenkt Ihnen einen Gutschein für {r}',
		subjectSelf: 'Ihr Gutschein für {r}',
		heading: 'Ein Geschenkgutschein für Sie',
		lead: '{from} hat Ihnen einen Gutschein für {r} geschickt.',
		leadSelf: 'Hier ist Ihr Gutschein für {r}.',
	},
	labels: {
		amount: 'Betrag',
		code: 'Gutscheincode',
		from: 'Von',
		message: 'Nachricht',
		checkBalance: 'Guthaben prüfen',
		orderNow: 'Jetzt bestellen',
		addToAccount: 'Zu meinem Konto hinzufügen',
		deliversOn: 'Zustelldatum',
		fee: 'Bearbeitungsgebühr',
		total: 'Gesamt bezahlt',
		expires: 'Gültig bis',
		to: 'An',
		keepSafe: 'Bewahren Sie diese E-Mail auf: Jeder mit dem Code kann den Gutschein einlösen.',
	},
	designs: {
		classic: 'Geschenkgutschein',
		birthday: 'Alles Gute zum Geburtstag',
		holidays: 'Frohe Feiertage',
		thank_you: 'Danke',
		eid: 'Eid Mubarak',
		ramadan: 'Ramadan Kareem',
		national_day: 'Alles Gute zum Nationalfeiertag',
		custom: 'Geschenkgutschein',
	},
}

const zh: GiftCardCopy = {
	receipt: {
		subject: '您在 {r} 购买的礼品卡',
		heading: '感谢您购买礼品卡',
		lead: '付款已完成，礼品卡正在发送。',
		leadLater: '付款已完成。我们将在您选择的日期送出礼品卡。',
		leadHeld: '付款已完成。您的礼品卡将在 2 小时内送达。',
	},
	delivery: {
		subject: '{from} 送给您一张 {r} 礼品卡',
		subjectSelf: '您的 {r} 礼品卡',
		heading: '送给您的礼品卡',
		lead: '{from} 送给您一张 {r} 的礼品卡。',
		leadSelf: '这是您的 {r} 礼品卡。',
	},
	labels: {
		amount: '金额',
		code: '卡号',
		from: '来自',
		message: '留言',
		checkBalance: '查询余额',
		orderNow: '立即点餐',
		addToAccount: '添加到我的账户',
		deliversOn: '送达日期',
		fee: '手续费',
		total: '实付总额',
		expires: '有效期至',
		to: '送给',
		keepSafe: '请保留此邮件：任何持有卡号的人都可以使用该卡。',
	},
	designs: {
		classic: '礼品卡',
		birthday: '生日快乐',
		holidays: '节日快乐',
		thank_you: '谢谢',
		eid: '开斋节快乐',
		ramadan: '斋月吉祥',
		national_day: '国庆快乐',
		custom: '礼品卡',
	},
}

const COPY: Record<SiteContentLocale, GiftCardCopy> = { en, ar, es, fr, de, zh }

export function giftCardCopyFor(locale: SiteContentLocale): GiftCardCopy {
	return COPY[locale] ?? en
}

export function fillGiftCardCopy(
	template: string,
	values: Record<string, string>,
): string {
	return template.replace(/\{(\w+)\}/g, (match, key: string) =>
		key in values ? values[key]! : match,
	)
}
