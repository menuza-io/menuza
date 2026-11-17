// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
	applyDailyConstraints,
	readDailyAvailability,
} from './daily-availability.ts'
import { paintDailyCards } from './daily-cards.ts'
import { remainingFor } from './constraints.ts'

const labels = { onlyNLeft: 'Only {count} left' }

function row(id: string, published = false) {
	return `
<li class="js-item-card surface surface-interactive cursor-pointer" data-item-id="${id}" data-sold-out="${published}">
	<h3 class="text-foreground"><button class="js-item-open"><span>Dish ${id}</span></button></h3>
	<img src="x.jpg" alt="" />
	${
		published
			? '<span class="badge tone-solid">Sold out</span>'
			: `<span class="js-price-block">$10</span>
	<span class="js-sold-out-badge badge tone-solid" hidden>Sold out</span>
	<span class="js-daily-left badge tone-warning" hidden></span>
	<span class="add-btn"></span>`
	}
</li>`
}

function popular(id: string) {
	return `<button class="js-popular-card" data-item-id="${id}">
	<span class="js-price-block">$10</span>
	<span class="js-sold-out-badge badge" hidden>Sold out</span>
	<span class="js-daily-left badge" hidden></span>
	<span class="add-btn"></span>
</button>`
}

const card = (id: string) =>
	document.querySelector<HTMLElement>(`[data-item-id="${id}"]`)!
const availability = (
	entries: Record<string, { remaining: number; showRemaining: boolean }>,
) => readDailyAvailability({ dailyAvailability: entries })

afterEach(() => document.body.replaceChildren())

describe('paintDailyCards', () => {
	it('shows a sold-out dish as sold out and refuses its card', () => {
		document.body.innerHTML = `<ul>${row('a')}</ul>`
		paintDailyCards(
			document,
			availability({ 'item:a': { remaining: 0, showRemaining: false } }),
			labels,
		)
		const a = card('a')
		expect(a.dataset.soldOut).toBe('true')
		expect(a.getAttribute('aria-disabled')).toBe('true')
		expect(a.querySelector<HTMLButtonElement>('.js-item-open')!.disabled).toBe(
			true,
		)
		expect(a.querySelector<HTMLElement>('.js-sold-out-badge')!.hidden).toBe(
			false,
		)
		expect(a.querySelector<HTMLElement>('.js-price-block')!.hidden).toBe(true)
		expect(a.querySelector<HTMLElement>('.add-btn')!.hidden).toBe(true)
		expect(a.classList.contains('surface-interactive')).toBe(false)
		expect(a.classList.contains('border-dashed')).toBe(true)
	})

	it('says "Only N left" only where the region sent a number, and keeps the dish orderable', () => {
		document.body.innerHTML = `<ul>${row('a')}${row('b')}</ul>`
		paintDailyCards(
			document,
			availability({ 'item:a': { remaining: 3, showRemaining: true } }),
			labels,
		)
		const left = card('a').querySelector<HTMLElement>('.js-daily-left')!
		expect(left.hidden).toBe(false)
		expect(left.textContent).toBe('Only 3 left')
		expect(card('a').dataset.soldOut).toBe('false')
		expect(card('b').querySelector<HTMLElement>('.js-daily-left')!.hidden).toBe(
			true,
		)
	})

	it('gives a dish back when a later answer no longer lists it (a top-up)', () => {
		document.body.innerHTML = `<ul>${row('a')}</ul>`
		paintDailyCards(
			document,
			availability({ 'item:a': { remaining: 0, showRemaining: false } }),
			labels,
		)
		paintDailyCards(document, {}, labels)
		const a = card('a')
		expect(a.dataset.soldOut).toBe('false')
		expect(a.hasAttribute('aria-disabled')).toBe(false)
		expect(a.querySelector<HTMLButtonElement>('.js-item-open')!.disabled).toBe(
			false,
		)
		expect(a.querySelector<HTMLElement>('.js-sold-out-badge')!.hidden).toBe(
			true,
		)
		expect(a.querySelector<HTMLElement>('.js-price-block')!.hidden).toBe(false)
		expect(a.querySelector<HTMLElement>('.add-btn')!.hidden).toBe(false)
		expect(a.classList.contains('surface-interactive')).toBe(true)
		expect(a.classList.contains('border-dashed')).toBe(false)
	})

	it('leaves a dish the menu itself marks sold out untouched', () => {
		document.body.innerHTML = `<ul>${row('a', true)}</ul>`
		const before = { html: card('a').innerHTML, classes: card('a').className }
		paintDailyCards(
			document,
			availability({ 'item:a': { remaining: 5, showRemaining: true } }),
			labels,
		)
		expect(card('a').innerHTML).toBe(before.html)
		expect(card('a').className).toBe(before.classes)
		expect(card('a').dataset.soldOut).toBe('true')
	})

	it('paints the popular rail, whose cards are buttons', () => {
		document.body.innerHTML = popular('p')
		paintDailyCards(
			document,
			availability({ 'item:p': { remaining: 0, showRemaining: false } }),
			labels,
		)
		const p = card('p') as HTMLButtonElement
		expect(p.disabled).toBe(true)
		paintDailyCards(document, {}, labels)
		expect(p.disabled).toBe(false)
	})

	it('only reads dishes, never an option with the same id', () => {
		document.body.innerHTML = `<ul>${row('a')}</ul>`
		paintDailyCards(
			document,
			availability({ 'option:a': { remaining: 0, showRemaining: false } }),
			labels,
		)
		expect(card('a').dataset.soldOut).toBe('false')
	})
})

describe('applyDailyConstraints', () => {
	it('caps a sold-out dish at none and a shown low number at that number', () => {
		const target: Parameters<typeof applyDailyConstraints>[0] = {}
		applyDailyConstraints(
			target,
			availability({
				'item:out': { remaining: 0, showRemaining: false },
				'item:low': { remaining: 3, showRemaining: true },
				'option:o': { remaining: 0, showRemaining: false },
			}),
		)
		expect(target.items).toEqual({
			out: { inventory: 0 },
			low: { inventory: 3 },
		})
		expect(
			remainingFor('low', [{ itemId: 'low', quantity: 1 }], target as never)
				.max,
		).toBe(2)
		expect(remainingFor('out', [], target as never).max).toBe(0)
		expect(remainingFor('free', [], target as never).max).toBeNull()
	})

	it('frees a dish on the next answer, in the same object the modal and cart hold', () => {
		const target: Parameters<typeof applyDailyConstraints>[0] = {}
		const held = target
		applyDailyConstraints(
			target,
			availability({ 'item:a': { remaining: 0, showRemaining: false } }),
		)
		applyDailyConstraints(target, {})
		expect(held.items).toEqual({})
		expect(remainingFor('a', [], held as never).max).toBeNull()
	})
})
