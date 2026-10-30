import { loyaltyProgramAvailable } from './availability'
import { LoyaltyClientError } from './loyalty-client'
import { testProgram } from '@/test/loyalty/fixtures'

function client(program: () => Promise<unknown>) {
	return { program: program as () => Promise<never> }
}

describe('loyaltyProgramAvailable', () => {
	it('is true when the region answers a program', async () => {
		await expect(
			loyaltyProgramAvailable(client(async () => testProgram())),
		).resolves.toBe(true)
	})

	it('is false when loyalty is off, the answer fails or the region is unreachable', async () => {
		await expect(
			loyaltyProgramAvailable(client(async () => null)),
		).resolves.toBe(false)
		await expect(
			loyaltyProgramAvailable(
				client(async () => {
					throw new LoyaltyClientError('loyalty_unavailable', 503)
				}),
			),
		).resolves.toBe(false)
		await expect(
			loyaltyProgramAvailable(
				client(async () => {
					throw new LoyaltyClientError('network', 0)
				}),
			),
		).resolves.toBe(false)
	})
})
