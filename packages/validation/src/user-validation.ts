import { z } from 'zod'

export const USERNAME_MIN_LENGTH = 3
export const USERNAME_MAX_LENGTH = 20

export const UsernameSchema = z
	.string({ error: 'Username is required' })
	.min(USERNAME_MIN_LENGTH, { message: 'Username is too short' })
	.max(USERNAME_MAX_LENGTH, { message: 'Username is too long' })
	.regex(/^[a-zA-Z0-9_]+$/, {
		message: 'Username can only include letters, numbers, and underscores',
	})
	// users can type the username in any case, but we store it in lowercase
	.transform((value) => value.toLowerCase())

export const PASSWORD_MIN_LENGTH = 12

export const PasswordSchema = z
	.string({ error: 'Password is required' })
	.min(PASSWORD_MIN_LENGTH, {
		message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
	})
	.transform((val) => val.normalize('NFC'))
	// NOTE: bcrypt has a limit of 72 bytes (which should be plenty long)
	// https://github.com/mohammedzamakhan/epic-startup/issues/918
	.refine((val) => new TextEncoder().encode(val).length <= 72, {
		message: 'Password is too long',
	})
	.refine((val) => /[a-z]/.test(val), {
		message: 'Password must contain at least one lowercase letter',
	})
	.refine((val) => /[A-Z]/.test(val), {
		message: 'Password must contain at least one uppercase letter',
	})
	.refine((val) => /[0-9]/.test(val), {
		message: 'Password must contain at least one number',
	})
	.refine((val) => /[^a-zA-Z0-9]/.test(val), {
		message: 'Password must contain at least one special character',
	})

export const LoginPasswordSchema = z
	.string({ error: 'Password is required' })
	.transform((val) => val.normalize('NFC'))

export const NameSchema = z
	.string({ error: 'Name is required' })
	.min(3, { message: 'Name is too short' })
	.max(40, { message: 'Name is too long' })

export const EmailSchema = z
	.string({ error: 'Email is required' })
	.email({ message: 'Email is invalid' })
	.min(3, { message: 'Email is too short' })
	.max(100, { message: 'Email is too long' })
	// users can type the email in any case, but we store it in lowercase
	.transform((value) => value.toLowerCase())

export const PasswordAndConfirmPasswordSchema = z
	.object({ password: PasswordSchema, confirmPassword: PasswordSchema })
	.superRefine(({ confirmPassword, password }, ctx) => {
		if (confirmPassword !== password) {
			ctx.addIssue({
				path: ['confirmPassword'],
				code: 'custom',
				message: 'The passwords must match',
			})
		}
	})
