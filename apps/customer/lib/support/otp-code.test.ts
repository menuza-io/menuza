import { isCompleteOtp, otpDigits } from './otp-code'

describe('otpDigits', () => {
	it('keeps ASCII digits and drops everything else', () => {
		expect(otpDigits(' 12-34 56 ')).toBe('123456')
		expect(otpDigits('abc')).toBe('')
	})

	it('reads Arabic-Indic and Persian digits as ASCII', () => {
		expect(otpDigits('١٢٣٤٥٦')).toBe('123456')
		expect(otpDigits('۱۲۳۴۵۶')).toBe('123456')
	})

	it('stops at six digits, so a pasted message keeps the code only', () => {
		expect(otpDigits('Your code is 123456. It expires in 10 minutes')).toBe(
			'123456',
		)
	})
})

describe('isCompleteOtp', () => {
	it('needs exactly six ASCII digits', () => {
		expect(isCompleteOtp('123456')).toBe(true)
		expect(isCompleteOtp('12345')).toBe(false)
		expect(isCompleteOtp('١٢٣٤٥٦')).toBe(false)
	})
})
