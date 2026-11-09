import { describe, expect, it } from 'vitest'
import { pinGitLabInstanceUrl } from './instance-pin.js'

const selfHosted = JSON.stringify({
	instanceUrl: 'https://gitlab.acme.example',
})

describe('pinGitLabInstanceUrl', () => {
	it('refuses moving the stored token to another host', () => {
		expect(
			pinGitLabInstanceUrl(selfHosted, {
				instanceUrl: 'https://attacker.example',
			}),
		).toHaveProperty('error')
		// A connection made against gitlab.com cannot be pointed elsewhere either.
		expect(
			pinGitLabInstanceUrl('{}', { instanceUrl: 'https://attacker.example' }),
		).toHaveProperty('error')
	})

	it('pins the instance the OAuth flow stored in metadata', () => {
		const fromOAuth = JSON.stringify({
			metadata: { instanceUrl: 'https://gitlab.acme.example' },
		})
		expect(
			pinGitLabInstanceUrl(fromOAuth, {
				instanceUrl: 'https://attacker.example',
			}),
		).toHaveProperty('error')
		expect(pinGitLabInstanceUrl(fromOAuth, { defaultProject: 'p' })).toEqual({
			config: {
				defaultProject: 'p',
				instanceUrl: 'https://gitlab.acme.example',
			},
		})
	})

	it('refuses moving the token through the metadata field', () => {
		expect(
			pinGitLabInstanceUrl('{}', {
				metadata: { instanceUrl: 'https://attacker.example' },
			}),
		).toHaveProperty('error')
		expect(
			pinGitLabInstanceUrl(selfHosted, {
				instanceUrl: 'https://gitlab.acme.example',
				metadata: { instanceUrl: 'https://attacker.example' },
			}),
		).toHaveProperty('error')
		// The OAuth metadata as stored passes.
		const oauth = { metadata: { instanceUrl: 'https://gitlab.com' } }
		expect(pinGitLabInstanceUrl('{}', oauth)).toEqual({ config: oauth })
	})

	it('keeps the stored instance when an update omits it', () => {
		expect(pinGitLabInstanceUrl(selfHosted, { defaultProject: 'p' })).toEqual({
			config: {
				defaultProject: 'p',
				instanceUrl: 'https://gitlab.acme.example',
			},
		})
	})

	it('accepts the same instance, ignoring case and a trailing slash', () => {
		const next = { instanceUrl: 'https://GitLab.acme.example/' }
		expect(pinGitLabInstanceUrl(selfHosted, next)).toEqual({ config: next })
		expect(
			pinGitLabInstanceUrl(null, { instanceUrl: 'https://gitlab.com' }),
		).toEqual({ config: { instanceUrl: 'https://gitlab.com' } })
	})
})
