import { createCookieSessionStorage } from 'react-router'
import { ENV } from './env.js'

if (!ENV.SESSION_SECRET) {
	throw new Error(
		'SESSION_SECRET environment variable is required but not set. ' +
			'Please add SESSION_SECRET to your .env file. ' +
			'Example: SESSION_SECRET=your-secret-key-here',
	)
}

const verificationSecrets = ENV.SESSION_SECRET.split(',').map((s) =>
	s.trim(),
)
if (
	verificationSecrets.length === 0 ||
	verificationSecrets.some((s) => s.length === 0)
) {
	throw new Error(
		'SESSION_SECRET must contain at least one non-empty secret. ' +
			'Example: SESSION_SECRET=your-secret-key-here',
	)
}

export const verifySessionStorage = createCookieSessionStorage({
	cookie: {
		name: 'en_verification',
		sameSite: 'lax',
		path: '/',
		httpOnly: true,
		maxAge: 60 * 10, // 10 minutes
		secrets: verificationSecrets,
		secure: ENV.NODE_ENV === 'production',
	},
})
