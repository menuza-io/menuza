import { describe, expect, it } from 'vitest'
import {
	mailboxRecipient,
	mailboxReplyUrl,
	mailboxSender,
	type MailboxItem,
} from './mailbox.ts'

const item: MailboxItem = {
	id: 'submission',
	formId: 'contact',
	formName: 'Contact',
	isRead: false,
	createdAt: null,
	fields: [
		{ id: 'email', type: 'email', label: 'Email', required: false },
		{ id: 'name', type: 'name', label: 'Name', required: false },
	],
	values: { email: 'rana@example.com', name: 'Rana' },
}
describe('mailbox email replies', () => {
	it('uses typed email fields, never arbitrary message text', () => {
		expect(mailboxRecipient(item)).toBe('rana@example.com')
		expect(mailboxSender(item)).toBe('Rana')
		expect(
			mailboxRecipient({ ...item, values: { message: 'rana@example.com' } }),
		).toBeNull()
		expect(
			mailboxRecipient({ ...item, values: { email: 'invalid' } }),
		).toBeNull()
	})
	it('encodes recipient, subject and body independently and strips subject newlines', () => {
		const url = mailboxReplyUrl(
			'rana+shop@example.com',
			'Re: Hello\r\nBcc: other@example.com',
			'Thanks & welcome\nHow can we help?',
		)!
		expect(url).toContain('mailto:rana%2Bshop%40example.com?subject=')
		const params = new URLSearchParams(url.split('?')[1])
		expect(params.get('subject')).not.toMatch(/[\r\n]/)
		expect(params.get('body')).toBe('Thanks & welcome\r\nHow can we help?')
		expect(mailboxReplyUrl('bad\n@example.com', 'Hello', 'Hi')).toBeNull()
	})
})
