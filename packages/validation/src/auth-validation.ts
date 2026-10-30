import { z } from 'zod'
import {
	UsernameSchema,
	PasswordSchema,
	EmailSchema,
} from './user-validation.ts'

export const LoginFormSchema = z.object({
	username: UsernameSchema,
	password: PasswordSchema,
	redirectTo: z.string().optional(),
	remember: z.boolean().optional(),
})

export const SignupSchema = z.object({
	email: EmailSchema,
})

// Mobile-compatible versions with simplified validation for better UX
export const MobileLoginFormSchema = z.object({
	username: z
		.string({ error: 'Username is required' })
		.min(1, { message: 'Username is required' }),
	password: z
		.string({ error: 'Password is required' })
		.min(1, { message: 'Password is required' }),
	redirectTo: z.string().optional(),
	remember: z.boolean().optional(),
})

export const MobileSignupSchema = z.object({
	email: z
		.string({ error: 'Email is required' })
		.email({ message: 'Please enter a valid email address' })
		.min(1, { message: 'Email is required' }),
})

// OAuth validation schemas
export const OAuthCallbackSchema = z.object({
	code: z.string(),
	state: z.string().optional(),
	error: z.string().optional(),
	error_description: z.string().optional(),
})

export const SocialAuthSchema = z.object({
	provider: z.enum(['google', 'github', 'discord']),
	redirectTo: z.string().optional(),
})
