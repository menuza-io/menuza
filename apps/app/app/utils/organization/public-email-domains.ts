/**
 * Mailbox providers open to anyone. An organization cannot claim these as a
 * verified domain, because a claim enrolls every account on the domain. The
 * settings form rejects them, and the places that act on a claim (sign-up
 * auto-join, domain discovery) ignore them too.
 */
const PUBLIC_EMAIL_DOMAINS = new Set([
	'gmail.com',
	'googlemail.com',
	'yahoo.com',
	'ymail.com',
	'hotmail.com',
	'outlook.com',
	'live.com',
	'msn.com',
	'icloud.com',
	'me.com',
	'mac.com',
	'aol.com',
	'proton.me',
	'protonmail.com',
	'protonmail.ch',
	'tutanota.com',
	'tuta.com',
	'tuta.io',
	'mail.ru',
	'rocketmail.com',
	'yahoo.co.uk',
	'hotmail.co.uk',
	'live.co.uk',
	'outlook.sa',
	'pm.me',
	'gmx.com',
	'gmx.net',
	'mail.com',
	'zoho.com',
	'yandex.com',
	'fastmail.com',
	'hey.com',
	'qq.com',
	'163.com',
])

export function isPublicEmailDomain(domain: string) {
	return PUBLIC_EMAIL_DOMAINS.has(domain.trim().toLowerCase())
}
