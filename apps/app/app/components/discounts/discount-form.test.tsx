// @vitest-environment jsdom
import { screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	type DiscountChoiceCatalog,
	type EditorErrors,
	type EditorState,
	emptyEditorState,
	newTier,
} from '#app/utils/discounts/editor-model.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { DiscountForm } from './discount-form.tsx'

const CATALOG = {
	items: [
		{ id: 'pizza', name: 'Pizza', detail: null },
		{ id: 'fries', name: 'Fries', detail: null },
	],
	categories: [{ id: 'pizzas', name: 'Pizzas', detail: null }],
}
const CHOICES: DiscountChoiceCatalog = {
	groups: [{ id: 'toppings', name: 'Toppings', detail: null }],
	options: [{ id: 'ranch', name: 'Ranch', detail: null }],
	variantGroups: [
		{
			key: 'size',
			name: 'Size',
			items: 2,
			values: [{ id: 'large', name: 'Large', detail: null }],
		},
	],
}
const ONE_LANGUAGE = { locales: ['en' as const], defaultLocale: 'en' as const }

const originalScrollIntoView = Element.prototype.scrollIntoView

beforeEach(() => {
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
	vi.unstubAllGlobals()
	Element.prototype.scrollIntoView = originalScrollIntoView
})

function form(
	overrides: Partial<React.ComponentProps<typeof DiscountForm>> & {
		state?: Partial<EditorState>
	} = {},
) {
	const { state, ...props } = overrides
	return (
		<DiscountForm
			orgSlug="acme"
			mode="edit"
			currency="USD"
			features={{ automatic: true, coupons: true }}
			catalog={CATALOG}
			locations={[]}
			choices={CHOICES}
			siteLocales={ONE_LANGUAGE}
			initial={{
				...emptyEditorState(),
				name: { en: 'Lunch' },
				percent: '10',
				...state,
			}}
			version={1}
			status="active"
			canWrite
			errors={{}}
			stale={false}
			formError={false}
			isSubmitting={false}
			{...props}
		/>
	)
}

function radio(name: RegExp) {
	return screen.getByRole('radio', { name })
}

// Base UI marks a switched-off radio or switch with aria-disabled, not disabled.
function isOff(element: HTMLElement) {
	return element.getAttribute('aria-disabled') === 'true'
}

describe('DiscountForm section ids', () => {
	it('gives every element its own id, so error focus reaches the field', () => {
		renderStaff(
			form({
				state: {
					application: 'code',
					scope: 'items',
					itemIds: ['pizza'],
					codes: [{ key: 'c1', id: null, code: 'LUNCH10', maxUses: '' }],
					requireOn: true,
					tiersOn: false,
				},
			}),
		)
		const ids = [...document.querySelectorAll('[id]')].map((node) => node.id)
		const repeated = ids.filter((id, index) => ids.indexOf(id) !== index)
		expect(repeated).toEqual([])
		// The section cards no longer take the id of the field inside them.
		expect(document.querySelectorAll('#discount-target')).toHaveLength(1)
		expect(document.querySelector('#discount-target')?.tagName).not.toBe('DIV')
		expect(
			document.querySelector('#discount-codes')?.getAttribute('role'),
		).not.toBe('group')
		expect(document.getElementById('discount-section-target')).not.toBeNull()
		expect(document.getElementById('discount-section-codes')).not.toBeNull()
	})
})

describe('DiscountForm tiers', () => {
	const tiered: Partial<EditorState> = {
		tiersOn: true,
		tiers: [newTier('30', '5'), newTier('50', '15')],
	}

	it('greys out what would silently drop the ladder, and says why', () => {
		renderStaff(form({ state: tiered }))
		for (const name of [
			/Buy some, discount some/,
			/At least a quantity/,
			/Groups of a quantity/,
			/Buy one group, discount another/,
			/Meal deal/,
			/At the till/,
			/Modifier choices/,
			/Set price/,
			/Free delivery/,
		]) {
			expect(isOff(radio(name))).toBe(true)
		}
		expect(isOff(radio(/Every qualifying item/))).toBe(false)
		expect(
			screen.getAllByText(/Not available with tiers\. Turn tiers off first\./)
				.length,
		).toBeGreaterThan(3)
	})

	it('lets the choices back in when tiers are turned off', async () => {
		renderStaff(form({ state: tiered }))
		await userEvent.click(screen.getByRole('switch', { name: /Use tiers/ }))
		expect(isOff(radio(/Meal deal/))).toBe(false)
		expect(isOff(radio(/At the till/))).toBe(false)
	})

	it('does not offer tiers on a discount they cannot go with, and says so', () => {
		renderStaff(form({ state: { quantityKind: 'minimum' } }))
		const toggle = screen.getByRole('switch', { name: /Use tiers/ })
		expect(isOff(toggle)).toBe(true)
		expect(
			screen.getByText(/Tiers go with a plain item or order discount/),
		).toBeTruthy()
	})
})

describe('DiscountForm amount off', () => {
	it('says each on an item discount and once on the order', () => {
		const { unmount } = renderStaff(
			form({ state: { valueType: 'fixed', amount: '5' } }),
		)
		expect(screen.getByLabelText('Amount off')).toBeTruthy()
		expect(screen.getByText(/Taken off the order once/)).toBeTruthy()
		unmount()
		renderStaff(
			form({
				state: {
					valueType: 'fixed',
					amount: '5',
					scope: 'items',
					itemIds: ['pizza'],
				},
			}),
		)
		expect(screen.getByLabelText('Amount off each item')).toBeTruthy()
		expect(screen.getByText(/Taken off each matching item/)).toBeTruthy()
	})
})

describe('DiscountForm per-customer limit', () => {
	it('says guests cannot use a discount that counts customers', () => {
		renderStaff(form())
		expect(screen.getByText(/Guests can't use this discount/)).toBeTruthy()
		expect(
			screen.queryByText(/Only signed-in customers can be counted/),
		).toBeNull()
	})
})

describe('DiscountForm repeated rows and fragments', () => {
	it('numbers the fields of each code row and tier row for a screen reader', () => {
		const { unmount } = renderStaff(
			form({
				state: {
					application: 'code',
					codes: [
						{ key: 'c1', id: null, code: 'LUNCH10', maxUses: '' },
						{ key: 'c2', id: null, code: 'LUNCH20', maxUses: '' },
					],
				},
			}),
		)
		expect(screen.getByRole('textbox', { name: 'Code 1' })).toBeTruthy()
		expect(screen.getByRole('textbox', { name: 'Code 2' })).toBeTruthy()
		expect(
			screen.getByRole('textbox', { name: 'Use limit for code 2' }),
		).toBeTruthy()
		unmount()
		renderStaff(
			form({
				state: {
					tiersOn: true,
					tiers: [newTier('30', '5'), newTier('50', '15')],
				},
			}),
		)
		expect(
			screen.getByRole('textbox', { name: 'Tier 1: spend at least' }),
		).toBeTruthy()
		expect(
			screen.getByRole('textbox', { name: 'Tier 2: spend at least' }),
		).toBeTruthy()
		expect(
			screen.getByRole('textbox', { name: 'Tier 2: percent off' }),
		).toBeTruthy()
	})

	it('names the day on each Add hours button with one message', async () => {
		renderStaff(form({ state: { hoursOn: true } }))
		const buttons = screen.getAllByRole('button', { name: /^Add hours on / })
		expect(buttons).toHaveLength(7)
		expect(buttons[0]).toHaveTextContent('Add hours')
	})

	it('puts the currency in its own isolate, never as a leading fragment', () => {
		renderStaff(form({ state: { valueType: 'fixed', amount: '5' } }))
		const hint = screen.getByText(/Taken off the order once/)
		expect(hint.textContent).toMatch(/^Amount in USD\./)
		expect(hint.querySelector('bdi')).toHaveTextContent('USD')
	})

	it('says the currency of the cap on a percentage', () => {
		renderStaff(form())
		const hint = screen.getByText(/Optional cap for one order/)
		expect(hint.querySelector('bdi')).toHaveTextContent('USD')
	})

	it('words the per-customer period as whole phrases', async () => {
		renderStaff(form({ state: { perCustomerOn: true } }))
		expect(radio(/Counts across all time/)).toBeTruthy()
		expect(radio(/Starts again every day/)).toBeTruthy()
		expect(screen.getByLabelText('Uses allowed')).toBeTruthy()
	})

	it('isolates only the numbers in the description counter', () => {
		renderStaff(form({ state: { description: { en: 'Hello' } } }))
		const counter = screen.getByText(/of/, { selector: 'span.tabular-nums' })
		expect(counter).not.toHaveAttribute('dir')
		expect(
			[...counter.querySelectorAll('bdi')].map((n) => n.textContent),
		).toEqual(['5', '75'])
	})

	it('says "Can combine with" for the stacking choices', () => {
		renderStaff(form())
		expect(screen.getByText('Can combine with')).toBeTruthy()
		expect(screen.queryByText('Stacks with')).toBeNull()
	})
})

describe('DiscountForm unsaved changes', () => {
	it('tells the status actions when the form has edits, and they stop', async () => {
		renderStaff(
			form({
				statusActions: ({ dirty }) => (
					<button type="button" disabled={dirty}>
						Pause now
					</button>
				),
			}),
		)
		expect(screen.getByRole('button', { name: 'Pause now' })).toBeEnabled()
		expect(screen.queryByText(/You have unsaved changes/)).toBeNull()
		await userEvent.type(screen.getByLabelText('Name'), '!')
		expect(screen.getByRole('button', { name: 'Pause now' })).toBeDisabled()
		expect(screen.getByText(/You have unsaved changes/)).toBeTruthy()
		// Putting the text back is no change at all.
		await userEvent.type(screen.getByLabelText('Name'), '{Backspace}')
		expect(screen.getByRole('button', { name: 'Pause now' })).toBeEnabled()
	})
})

describe('DiscountForm status', () => {
	it('shows the status and explains a paused discount', () => {
		renderStaff(form({ status: 'paused' }))
		expect(screen.getAllByText('Paused').length).toBeGreaterThan(0)
		expect(screen.getByText(/This discount is paused/)).toBeTruthy()
	})

	it('locks an archived discount and explains how to bring it back', () => {
		renderStaff(form({ status: 'archived', state: { application: 'code' } }))
		expect(screen.getByText(/This discount is archived/)).toBeTruthy()
		expect(screen.getByText(/coupon codes are not brought back/)).toBeTruthy()
		expect(screen.getByRole('button', { name: /Save discount/ })).toBeDisabled()
		expect(screen.getByLabelText('Name')).toBeDisabled()
	})

	it('says a way of applying is switched off instead of leaving a bare radio', () => {
		renderStaff(form({ features: { automatic: true, coupons: false } }))
		expect(isOff(radio(/Coupon code/))).toBe(true)
		expect(screen.getByText('Switched off for your organization.')).toBeTruthy()
	})
})

function Harness({ initialErrors }: { initialErrors: EditorErrors }) {
	const [errors, setErrors] = useState(initialErrors)
	return (
		<>
			<button type="button" onClick={() => setErrors({ ...initialErrors })}>
				resubmit
			</button>
			{form({ errors })}
		</>
	)
}

describe('DiscountForm errors', () => {
	it('moves focus to the error summary again when the same errors come back', async () => {
		renderStaff(<Harness initialErrors={{ name: 'required' }} />)
		const summary = screen.getByRole('alert')
		expect(summary).toHaveFocus()
		await userEvent.click(screen.getByLabelText('Description'))
		expect(summary).not.toHaveFocus()
		await userEvent.click(screen.getByRole('button', { name: 'resubmit' }))
		expect(summary).toHaveFocus()
		// The summary links to the field.
		await userEvent.click(screen.getByRole('link', { name: /Name: Enter/ }))
		expect(screen.getByLabelText('Name')).toHaveFocus()
	})

	it('raises one alert for a failed save, not two', () => {
		const { unmount } = renderStaff(
			form({ formError: true, errors: { name: 'required' } }),
		)
		expect(screen.getAllByRole('alert')).toHaveLength(1)
		expect(screen.queryByText(/could not be saved/)).toBeNull()
		unmount()
		renderStaff(form({ formError: true }))
		const alerts = screen.getAllByRole('alert')
		expect(alerts).toHaveLength(1)
		expect(alerts[0]).toHaveTextContent(/could not be saved/)
		expect(alerts[0]).toHaveFocus()
	})

	it('ties the description and maximum uses errors to their fields', () => {
		renderStaff(
			form({
				errors: { description: 'too_long', totalLimit: 'range:1:1000000' },
			}),
		)
		for (const label of ['Description', 'Maximum uses']) {
			const field = screen.getByLabelText(label)
			const errorId = field.getAttribute('aria-describedby')
			expect(errorId).toBeTruthy()
			expect(document.getElementById(errorId!)).toHaveTextContent(/\S/)
			expect(field).toHaveAttribute('aria-invalid', 'true')
		}
	})

	it('names the field in the error list and says "Maximum uses" like the field does', () => {
		renderStaff(
			form({
				errors: {
					maxUnits: 'range:1:1000',
					totalLimit: 'range:1:1000000',
					quantityN: 'range:2:1000',
				},
			}),
		)
		const alert = screen.getByText('Fix these before saving.').closest('div')!
		const list = within(alert)
		expect(
			list.getByText(
				/Items discounted per use: Enter a whole number from 1 to 1000/,
			),
		).toBeTruthy()
		expect(list.getByText(/Maximum uses: /)).toBeTruthy()
		expect(
			list.getByText(/Quantity: Enter a whole number from 2 to 1000/),
		).toBeTruthy()
	})

	it('clears the saved banner once an error or an edit follows the save', async () => {
		const withSaved = { route: '/discounts/d1?saved=1' }
		const { unmount } = renderStaff(form(), withSaved)
		expect(screen.getByText('Saved.')).toBeTruthy()
		await userEvent.type(screen.getByLabelText('Name'), '!')
		expect(screen.queryByText('Saved.')).toBeNull()
		unmount()
		renderStaff(form({ errors: { name: 'required' } }), withSaved)
		expect(screen.queryByText('Saved.')).toBeNull()
	})

	it('keeps the edits and says so after a stale save', () => {
		renderStaff(form({ stale: true, keepEdits: true }))
		expect(screen.getByText(/Your changes are still here/)).toBeTruthy()
		expect(screen.queryByText(/Reload the page/)).toBeNull()
	})
})

describe('DiscountForm limits and currencies', () => {
	it('words the discount limit at page level, not on a field', () => {
		renderStaff(form({ limit: 'discounts', formError: false }))
		const alert = screen.getByText(
			'You have reached the limit of 500 discounts. Archive some you no longer use.',
		)
		expect(alert.getAttribute('role')).toBe('alert')
		expect(screen.queryByText('Fix these before saving.')).toBeNull()
		expect(screen.queryByText('Saved.')).toBeNull()
	})

	it('words the organization code limit apart from the 90-per-discount one', () => {
		renderStaff(
			form({
				errors: { codes: 'org_codes_limit' },
				limit: 'codes',
				state: {
					application: 'code',
					codes: [{ key: 'c1', id: null, code: 'LUNCH10', maxUses: '' }],
				},
			}),
		)
		const alert = screen.getByText('Fix these before saving.').closest('div')!
		expect(
			within(alert).getByText(
				/You have reached the limit of 2,000 coupon codes across all discounts\./,
			),
		).toBeTruthy()
		expect(screen.queryByText(/up to 90 codes/)).toBeNull()
	})

	it('keeps the 90-code message for one discount', () => {
		renderStaff(
			form({
				errors: { codes: 'too_many_codes' },
				state: {
					application: 'code',
					codes: [{ key: 'c1', id: null, code: 'LUNCH10', maxUses: '' }],
				},
			}),
		)
		expect(screen.getAllByText(/up to 90 codes/).length).toBeGreaterThan(0)
		expect(screen.queryByText(/2,000 coupon codes/)).toBeNull()
	})

	it('switches off amounts in a currency orders cannot count yet', () => {
		renderStaff(form({ currency: 'KWD', status: 'paused' }))
		expect(isOff(radio(/Amount off/))).toBe(true)
		expect(isOff(radio(/Set price/))).toBe(true)
		expect(isOff(radio(/Percentage off/))).toBe(false)
		expect(document.body.textContent).toContain(
			'Not available yet for KWD. Use a percentage.',
		)
	})

	it('leaves amounts on in a two-decimal currency', () => {
		renderStaff(form({ currency: 'USD' }))
		expect(isOff(radio(/Amount off/))).toBe(false)
		expect(screen.queryByText(/Not available yet for/)).toBeNull()
	})

	it('names the currency in the refusal', () => {
		renderStaff(
			form({
				currency: 'KWD',
				errors: { valueType: 'amounts_unavailable' },
				state: { valueType: 'fixed', percent: '', amount: '1.000' },
			}),
		)
		const alert = screen.getByText('Fix these before saving.').closest('div')!
		expect(
			within(alert).getByText(
				/Amounts off aren't available yet for KWD; use a percentage\./,
			),
		).toBeTruthy()
	})
})

describe('DiscountForm currency', () => {
	const LOCATIONS = [
		{ id: 'to', name: 'Toronto', currency: 'CAD', active: true },
		{ id: 'bo', name: 'Boston', currency: 'USD', active: true },
	]

	it('explains that locations must share a currency when an amount is set across several', () => {
		renderStaff(
			form({
				locations: LOCATIONS,
				state: { valueType: 'fixed', percent: '', amount: '5' },
			}),
		)
		expect(
			screen.getByText(
				/Your locations use different currencies\. Choose locations that share one currency to set an amount\./,
			),
		).toBeTruthy()
		// No currency can be named yet, so the amount input shows no unit.
		expect(
			document
				.getElementById('discount-amount')
				?.closest('[data-slot="input-group"]'),
		).not.toHaveTextContent(/CAD|USD/)
	})

	it('stays quiet for a percentage, or when the locations share a currency', () => {
		const { unmount } = renderStaff(form({ locations: LOCATIONS }))
		expect(screen.queryByText(/use different currencies/)).toBeNull()
		unmount()
		renderStaff(
			form({
				locations: [LOCATIONS[0]!],
				state: { valueType: 'fixed', percent: '', amount: '5' },
			}),
		)
		expect(screen.queryByText(/use different currencies/)).toBeNull()
		// The hint names the currency and the amount input shows it as its unit.
		expect(screen.getAllByText(/CAD/).length).toBeGreaterThan(1)
		expect(
			document
				.getElementById('discount-amount')
				?.closest('[data-slot="input-group"]'),
		).toHaveTextContent('CAD')
	})
})

describe('DiscountForm languages', () => {
	const TWO_LANGUAGES = {
		locales: ['en' as const, 'ar' as const],
		defaultLocale: 'en' as const,
	}

	it('shows no language switcher for a one-language website', () => {
		renderStaff(form())
		expect(
			screen.queryByRole('radiogroup', { name: 'Content language' }),
		).toBeNull()
	})

	it('writes the name in each website language', async () => {
		function Probe() {
			return form({ siteLocales: TWO_LANGUAGES })
		}
		renderStaff(<Probe />)
		const switcher = screen.getByRole('radiogroup', {
			name: 'Content language',
		})
		expect(screen.getByLabelText('Name')).toHaveValue('Lunch')
		await userEvent.click(within(switcher).getByRole('radio', { name: /AR/i }))
		const name = screen.getByLabelText('Name')
		expect(name).toHaveValue('')
		expect(name).toHaveAttribute('dir', 'rtl')
		expect(screen.getByText(/Writing the Arabic version/)).toBeTruthy()
		await userEvent.type(name, 'غداء')
		const posted = JSON.parse(
			(document.querySelector('input[name="state"]') as HTMLInputElement).value,
		) as EditorState
		expect(posted.name).toEqual({ en: 'Lunch', ar: 'غداء' })
	})
})

describe('DiscountForm option filter', () => {
	it('is hidden when the menu has no option types', () => {
		renderStaff(
			form({
				choices: { ...CHOICES, variantGroups: [] },
				state: { scope: 'items', itemIds: ['pizza'] },
			}),
		)
		expect(screen.queryByText('Only these options')).toBeNull()
	})

	it('adds an option type, and stops once every type is used', async () => {
		renderStaff(form({ state: { scope: 'items', itemIds: ['pizza'] } }))
		expect(screen.getByText('Only these options')).toBeTruthy()
		const add = screen.getByRole('button', { name: 'Add option type' })
		await userEvent.click(add)
		expect(
			screen.getByRole('combobox', { name: 'Option type 1' }),
		).toHaveTextContent('Size')
		expect(add).toBeDisabled()
		await userEvent.click(
			screen.getByRole('button', { name: 'Remove option type 1' }),
		)
		expect(screen.queryByRole('combobox', { name: 'Option type 1' })).toBeNull()
		expect(add).toBeEnabled()
	})

	it('shows a stored filter with the menu names and its error', () => {
		renderStaff(
			form({
				state: {
					scope: 'categories',
					categoryIds: ['pizzas'],
					variants: [{ group: 'size', values: ['large'] }],
				},
				errors: { variants: 'too_many_variants' },
			}),
		)
		expect(
			screen.getByRole('combobox', { name: 'Option type 1' }),
		).toHaveTextContent('Size')
		// The error sits in the filter, tied to it for screen readers.
		const filter = document.getElementById('discount-variants')!
		expect(filter.getAttribute('aria-describedby')).toContain(
			'discount-variants-error',
		)
		expect(
			document.getElementById('discount-variants-error'),
		).toHaveTextContent(/up to 3 option types, with up to 50 options each/)
		const alert = screen.getByText('Fix these before saving.').closest('div')!
		expect(within(alert).getByText(/^Only these options: /)).toBeTruthy()
	})
})
