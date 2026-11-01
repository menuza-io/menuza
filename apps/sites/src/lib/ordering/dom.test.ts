import { describe, expect, it } from 'vitest'
import { isActionEnter, isComposingKey } from './dom'

const key = (
	over: Partial<Pick<KeyboardEvent, 'key' | 'isComposing' | 'keyCode'>>,
) => ({
	key: 'Enter',
	isComposing: false,
	keyCode: 13,
	...over,
})

describe('Enter and input methods', () => {
	it('acts on a plain Enter', () => {
		expect(isActionEnter(key({}))).toBe(true)
	})

	it('leaves an Enter that confirms an input-method candidate alone', () => {
		expect(isActionEnter(key({ isComposing: true, keyCode: 229 }))).toBe(false)
		expect(isComposingKey(key({ isComposing: true, keyCode: 229 }))).toBe(true)
	})

	it('catches the Safari Enter that ends a composition, sent with key code 229', () => {
		expect(isActionEnter(key({ isComposing: false, keyCode: 229 }))).toBe(false)
		expect(isComposingKey(key({ key: 'ArrowDown', keyCode: 229 }))).toBe(true)
	})

	it('acts on no other key', () => {
		expect(isActionEnter(key({ key: 'a', keyCode: 65 }))).toBe(false)
		expect(isComposingKey(key({ key: 'ArrowDown', keyCode: 40 }))).toBe(false)
	})
})
