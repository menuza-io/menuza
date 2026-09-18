import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { render } from '@react-email/components'
import { brand } from '@repo/config/brand'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'

import { emailBrandLogoUrl } from '../theme'
import CommentEmail from './comment-email'
import ContactTemplate from './contact'
import EmailChangeEmail from './email-change'
import EmailChangeNoticeEmail from './email-change-notice'
import ForgotPasswordEmail from './forgot-password'
import InvoiceEmail from './invoice'
import MentionEmail from './mention-email'
import NewDeviceSigninEmail from './new-device-signin'
import OrganizationInviteEmail from './organization-invite'
import SignupEmail from './signup'
import TrialEndingEmail from './trial-ending'

const cases = [
	{
		name: 'SignupEmail',
		element: createElement(SignupEmail, SignupEmail.PreviewProps),
		cta: SignupEmail.PreviewProps.onboardingUrl,
	},
	{
		name: 'ForgotPasswordEmail',
		element: createElement(
			ForgotPasswordEmail,
			ForgotPasswordEmail.PreviewProps,
		),
		cta: ForgotPasswordEmail.PreviewProps.onboardingUrl,
	},
	{
		name: 'EmailChangeEmail',
		element: createElement(EmailChangeEmail, EmailChangeEmail.PreviewProps),
		cta: EmailChangeEmail.PreviewProps.verifyUrl,
	},
	{
		name: 'EmailChangeNoticeEmail',
		element: createElement(
			EmailChangeNoticeEmail,
			EmailChangeNoticeEmail.PreviewProps,
		),
		cta: undefined,
	},
	{
		name: 'OrganizationInviteEmail',
		element: createElement(
			OrganizationInviteEmail,
			OrganizationInviteEmail.PreviewProps,
		),
		cta: OrganizationInviteEmail.PreviewProps.inviteUrl,
	},
	{
		name: 'TrialEndingEmail',
		element: createElement(TrialEndingEmail, TrialEndingEmail.PreviewProps),
		cta: TrialEndingEmail.PreviewProps.portalUrl,
	},
	{
		name: 'NewDeviceSigninEmail',
		element: createElement(
			NewDeviceSigninEmail,
			NewDeviceSigninEmail.PreviewProps,
		),
		cta: NewDeviceSigninEmail.PreviewProps.secureAccountUrl,
	},
	{
		name: 'InvoiceEmail',
		element: createElement(InvoiceEmail, InvoiceEmail.PreviewProps),
		cta: InvoiceEmail.PreviewProps.downloadUrl,
	},
	{
		name: 'ContactTemplate',
		element: createElement(ContactTemplate, ContactTemplate.PreviewProps),
		cta: undefined,
	},
	{
		name: 'CommentEmail',
		element: createElement(CommentEmail, CommentEmail.PreviewProps),
		cta: CommentEmail.PreviewProps.noteUrl,
	},
	{
		name: 'MentionEmail',
		element: createElement(MentionEmail, MentionEmail.PreviewProps),
		cta: MentionEmail.PreviewProps.noteUrl,
	},
]

describe('transactional email templates', () => {
	for (const { name, element, cta } of cases) {
		it(`${name} renders the boxed shell`, async () => {
			const html = await render(element)

			expect(html).toContain('<!DOCTYPE html')
			// Header brand name and footer tagline come from @repo/config/brand, so a
			// renamed fork renders correctly without touching a template.
			expect(html).toContain(brand.name)
			expect(html).toContain(brand.tagline)
			expect(html).toContain(emailBrandLogoUrl)
			if (cta) expect(html).toContain(cta)
			// Email clients understand neither oklch() nor CSS variables — the token
			// mirror in theme.ts has to stay literal.
			expect(html).not.toContain('oklch(')
			expect(html).not.toContain('undefined')
		})
	}
})

/**
 * The spacing contract, lifted from the React Email demo this layout follows
 * (`apps/demo/emails/01-Barebone`). Each assertion here pins a defect that was
 * actually shipped once: an uncapped text measure, a rounded/padded sheet, and a
 * type scale that was bare sizes with no leading or tracking.
 */
describe('transactional email spacing', () => {
	it('applies vertical rhythm on Section wrappers', async () => {
		const html = await render(
			createElement(SignupEmail, SignupEmail.PreviewProps),
		)

		// Eyebrow, heading, body, code label, notes — not zeroed Text margins.
		expect(
			(html.match(/margin-bottom:24px/g) ?? []).length,
		).toBeGreaterThanOrEqual(5)
	})

	it('caps the text measure instead of letting copy run the card width', async () => {
		const html = await render(
			createElement(SignupEmail, SignupEmail.PreviewProps),
		)

		expect(html).toContain('max-width:420px')
		expect(html).toContain('max-width:440px')
		expect(html).toContain('max-width:280px')
	})

	it('insets the sheet rather than padding the page, and keeps it square', async () => {
		const html = await render(
			createElement(SignupEmail, SignupEmail.PreviewProps),
		)

		expect(html).toContain('padding-left:24px')
		expect(html).toContain('padding-top:16px')
		expect(html).not.toContain('border-radius:16px')
	})

	it('carries leading and tracking with each size', async () => {
		const html = await render(
			createElement(SignupEmail, SignupEmail.PreviewProps),
		)

		// Default h1 (28px) or hero h1 (40px), 16px body, 13px eyebrow/note, 11px footer.
		expect(
			html.includes('letter-spacing:-0.084px') ||
				html.includes('letter-spacing:-0.8px'),
		).toBe(true)
		expect(html).toContain('letter-spacing:-0.048px')
		expect(html).toContain('letter-spacing:-0.039px')
		expect(html).toContain('line-height:1.3')
	})

	it('aligns detail blocks to the body text measure', async () => {
		const html = await render(
			createElement(SignupEmail, SignupEmail.PreviewProps),
		)

		expect(html).toContain('max-width:420px')
		expect(html).toContain('max-width:440px')
	})

	it('keeps a 24px gutter between cards and tightens it on mobile', async () => {
		const html = await render(
			createElement(SignupEmail, SignupEmail.PreviewProps),
		)

		expect(html).toContain('margin-bottom:24px')
		expect(html).toContain('@media(max-width:600px)')
		expect(html).toContain('.mobile_mb-8px')
	})

	it('centers every shell footer line', async () => {
		const html = await render(
			createElement(SignupEmail, SignupEmail.PreviewProps),
		)

		const copyrightIndex = html.indexOf('All rights reserved')
		const copyrightChunk = html.slice(copyrightIndex - 280, copyrightIndex + 40)
		expect(copyrightChunk).toContain('text-align:center')

		const taglineIndex = html.indexOf(brand.tagline)
		const taglineChunk = html.slice(taglineIndex - 120, taglineIndex + 20)
		expect(taglineChunk).toContain('text-align:center')
	})
})

/**
 * The templates ship to every fork of this repo, so they must not describe any
 * one product. This is the guard that keeps domain language from creeping back
 * in when a template is edited.
 */
const DOMAIN_SPECIFIC_TERMS = [
	'Organize your thoughts',
	'note-taking',
	"captain's log",
	'your notes',
]

describe('transactional email copy', () => {
	const templatesDir = dirname(fileURLToPath(import.meta.url))

	it('stays free of domain-specific language', () => {
		const files = readdirSync(templatesDir).filter((file) =>
			file.endsWith('.tsx'),
		)
		expect(files.length).toBeGreaterThan(0)

		for (const file of files) {
			const source = readFileSync(join(templatesDir, file), 'utf8')
			for (const term of DOMAIN_SPECIFIC_TERMS) {
				expect(source, `${file} must not contain "${term}"`).not.toContain(term)
			}
		}
	})
})
