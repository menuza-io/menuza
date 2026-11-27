// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { type VoiceProposal } from '@repo/inventory'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
	type InventoryClient,
	InventoryClientContext,
} from './inventory-client-provider.tsx'
import {
	amountOfDraft,
	draftLinesOf,
	VoiceCountButton,
} from './voice-count.tsx'

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

afterEach(() => {
	vi.unstubAllGlobals()
})

const PROPOSAL: VoiceProposal = {
	transcript: 'three kilos of tomatoes',
	lines: [
		{
			itemId: 'it1',
			itemName: 'Tomatoes',
			amount: 3,
			unit: 'kg',
			unitLabel: 'kg',
			unitAssumed: false,
			heard: 'three kilos of tomatoes',
			match: 'exact',
		},
	],
	questions: [],
}

describe('voice count drafts', () => {
	it('turns a proposal into editable lines and reads the typed amount back', () => {
		const [line] = draftLinesOf(PROPOSAL)
		expect(line).toMatchObject({
			itemId: 'it1',
			amount: '3',
			unit: 'kg',
			heard: 'three kilos of tomatoes',
		})
		expect(amountOfDraft({ ...line!, amount: '2,5' })).toBe(2.5)
		expect(amountOfDraft({ ...line!, amount: '0' })).toBeNull()
		expect(amountOfDraft({ ...line!, amount: 'abc' })).toBeNull()
	})
})

function renderButton(
	request: InventoryClient['request'],
	props: { enabled?: boolean } = {},
) {
	return render(
		<I18nProvider i18n={i18n}>
			<InventoryClientContext.Provider value={{ orgSlug: 'acme', request }}>
				<VoiceCountButton
					locationId="main"
					enabled={props.enabled ?? true}
					onConfirm={vi.fn()}
				/>
			</InventoryClientContext.Provider>
		</I18nProvider>,
	)
}

describe('VoiceCountButton', () => {
	it('is hidden when the region has no speech model', async () => {
		vi.stubGlobal('navigator', { mediaDevices: {} })
		const request = vi.fn(async () => ({
			available: false,
		})) as unknown as InventoryClient['request']
		renderButton(request)
		await waitFor(() => expect(request).toHaveBeenCalled())
		expect(screen.queryByTestId('count-voice')).toBeNull()
	})

	it('is hidden, and asks nothing, while the feature is off', () => {
		vi.stubGlobal('navigator', { mediaDevices: {} })
		const request = vi.fn() as unknown as InventoryClient['request']
		renderButton(request, { enabled: false })
		expect(request).not.toHaveBeenCalled()
		expect(screen.queryByTestId('count-voice')).toBeNull()
	})

	it('shows the microphone when the region can listen', async () => {
		vi.stubGlobal('navigator', { mediaDevices: {} })
		const request = vi.fn(async () => ({
			available: true,
		})) as unknown as InventoryClient['request']
		renderButton(request)
		expect(await screen.findByTestId('count-voice')).toBeInTheDocument()
		expect(request).toHaveBeenCalledWith(expect.stringContaining('/voice?'))
	})

	it('says so when the microphone is not allowed, and sends nothing', async () => {
		const getUserMedia = vi.fn(async () => {
			throw new Error('denied')
		})
		vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
		const request = vi.fn(async () => ({
			available: true,
		})) as unknown as InventoryClient['request']
		renderButton(request)
		fireEvent.click(await screen.findByTestId('count-voice'))
		expect(await screen.findByTestId('count-voice-error')).toBeInTheDocument()
		expect(request).toHaveBeenCalledTimes(1)
	})
})
