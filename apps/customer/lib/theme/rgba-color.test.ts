import {
	BLACK,
	type RgbaColor,
	WHITE,
	colorsEqual,
	contrastRatio,
	isLightColor,
	mixColors,
	parseCssColor,
	parseSwiftDouble,
	rgba,
	toCssHexString,
	toHexString,
	withAlpha,
} from './rgba-color'

function expectClose(actual: number, expected: number, tolerance: number) {
	expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance)
}

function expectColor(
	color: RgbaColor | null,
	red: number,
	green: number,
	blue: number,
	{ alpha = 1, tolerance = 0.002 }: { alpha?: number; tolerance?: number } = {},
) {
	expect(color).not.toBeNull()
	if (!color) return
	expectClose(color.red, red, tolerance)
	expectClose(color.green, green, tolerance)
	expectClose(color.blue, blue, tolerance)
	expectClose(color.alpha, alpha, tolerance)
}

// Reference values were computed with Björn Ottosson's OKLab matrices, the
// same ones the earlier native iOS and Android apps used.
describe('parseCssColor (ported from RGBAColorTests.swift)', () => {
	it('parses opaque white and black', () => {
		expectColor(parseCssColor('oklch(1 0 0)'), 1, 1, 1)
		expectColor(parseCssColor('oklch(0 0 0)'), 0, 0, 0)
	})

	it('parses neutral grays', () => {
		expectColor(parseCssColor('oklch(0.145 0 0)'), 0.039388, 0.039388, 0.039388)
		expectColor(parseCssColor('oklch(0.985 0 0)'), 0.980256, 0.980256, 0.980256)
		expectColor(parseCssColor('oklch(0.205 0 0)'), 0.090527, 0.090527, 0.090527)
	})

	it('parses chromatic tokens', () => {
		expectColor(
			parseCssColor('oklch(0.577 0.245 27.325)'),
			0.906458,
			0,
			0.042215,
		)
		expectColor(
			parseCssColor('oklch(0.623 0.214 259.815)'),
			0.169333,
			0.498049,
			1,
		)
	})

	it('parses percentage lightness', () => {
		expectColor(
			parseCssColor('oklch(62.3% 0.214 259.815)'),
			0.169333,
			0.498049,
			1,
		)
	})

	it('parses alpha', () => {
		expectClose(
			parseCssColor('oklch(0.577 0.245 27.325 / 50%)')?.alpha ?? 0,
			0.5,
			0.0001,
		)
		expectClose(parseCssColor('rgb(255 0 0 / 0.25)')?.alpha ?? 0, 0.25, 0.0001)
	})

	it('parses hex forms', () => {
		expectColor(parseCssColor('#ffffff'), 1, 1, 1)
		expectColor(parseCssColor('#000'), 0, 0, 0)
		expectColor(parseCssColor('#ffffff1a'), 1, 1, 1, { alpha: 0.1019607843 })
		expectColor(
			parseCssColor('#0f0f0f'),
			0.0588235294,
			0.0588235294,
			0.0588235294,
		)
	})

	it('parses legacy rgb and hsl', () => {
		expectColor(parseCssColor('rgb(255, 0, 0)'), 1, 0, 0)
		expectColor(parseCssColor('rgba(0, 128, 255, 0.5)'), 0, 0.5019607843, 1, {
			alpha: 0.5,
		})
		expectColor(parseCssColor('hsl(0 100% 50%)'), 1, 0, 0)
		expectColor(parseCssColor('hsl(120, 100%, 25%)'), 0, 0.5, 0)
	})

	it('rejects invalid alpha', () => {
		expect(parseCssColor('rgb(255 0 0 / invalid)')).toBeNull()
		expect(parseCssColor('oklch(0.5 0.1 30 / nope)')).toBeNull()
		expect(parseCssColor('hsl(0 100% 50% / half)')).toBeNull()
	})

	it('rejects non-finite numbers', () => {
		expect(parseCssColor('rgb(nan 0 0)')).toBeNull()
		expect(parseCssColor('rgb(0 inf 0)')).toBeNull()
		expect(parseCssColor('oklch(nan 0.1 30)')).toBeNull()
		expect(parseCssColor('oklch(0.5 nan 30)')).toBeNull()
		expect(parseCssColor('oklch(0.5 0.1 nan)')).toBeNull()
		expect(parseCssColor('rgb(255 0 0 / nan)')).toBeNull()
		// A NaN that reaches the constructor must not leak into rendering.
		expect(rgba(NaN, 0, 0).red).toBe(0)
	})

	it('parses named colors', () => {
		expectColor(parseCssColor('white'), 1, 1, 1)
		expectColor(parseCssColor('transparent'), 0, 0, 0, { alpha: 0 })
	})

	it('rejects empty function bodies', () => {
		expect(parseCssColor('rgb()')).toBeNull()
		expect(parseCssColor('hsl()')).toBeNull()
		expect(parseCssColor('oklch()')).toBeNull()
	})

	it('rejects an unparsable hue but accepts none', () => {
		expect(parseCssColor('oklch(0.5 0.1 not-a-hue)')).toBeNull()
		expect(parseCssColor('oklch(0.5 0 none)')).not.toBeNull()
	})

	it('rejects relative color syntax', () => {
		expect(
			parseCssColor('oklch(from var(--destructive) min(l, 0.42) c h)'),
		).toBeNull()
		expect(parseCssColor('var(--primary)')).toBeNull()
		expect(parseCssColor('')).toBeNull()
	})

	it('has contrast and luminance helpers', () => {
		expect(isLightColor(WHITE)).toBe(true)
		expect(isLightColor(BLACK)).toBe(false)
		expectClose(contrastRatio(BLACK, WHITE), 21, 0.01)
		expect(toHexString(WHITE)).toBe('#ffffff')
		expect(toHexString(rgba(1, 0, 0))).toBe('#ff0000')
	})
})

describe('parseCssColor (ported from the Android RgbaColorTest)', () => {
	it('parses hex in every length', () => {
		expect(parseCssColor('#ffffff')).toEqual(rgba(1, 1, 1))
		expect(parseCssColor('#f00')).toEqual(rgba(1, 0, 0))
		expect(parseCssColor('#00000000')).toEqual(rgba(0, 0, 0, 0))
		expectClose(parseCssColor('#ff000080')?.alpha ?? 0, 0.5, 0.01)
		expect(parseCssColor('#12345')).toBeNull()
		expect(parseCssColor('#gggggg')).toBeNull()
		expect(parseCssColor('#')).toBeNull()
	})

	it('parses rgb, hsl and named colors', () => {
		expect(parseCssColor('rgb(255, 0, 0)')).toEqual(rgba(1, 0, 0))
		expect(parseCssColor('rgb(255 0 0 / 100%)')).toEqual(rgba(1, 0, 0))
		expectClose(parseCssColor('rgb(255 0 0 / 40%)')?.alpha ?? 0, 0.4, 0.001)
		expect(parseCssColor('hsl(0, 100%, 50%)')).toEqual(rgba(1, 0, 0))
		expect(parseCssColor('transparent')).toEqual(rgba(0, 0, 0, 0))
		expect(parseCssColor('color(display-p3 1 0 0)')).toBeNull()
	})

	it('parses oklch like the site theme compiler emits', () => {
		const blue = parseCssColor('oklch(0.488 0.243 264.376)')
		expect(blue).not.toBeNull()
		expect(blue?.blue ?? 0).toBeGreaterThan(blue?.red ?? 0)
	})

	it('drops alpha from the opaque hex form', () => {
		expect(toHexString(rgba(0, 0, 0, 0))).toBe('#000000')
	})

	it('sanitises non-finite and out-of-range components', () => {
		expect(rgba(NaN, 2, -1, 5)).toEqual(rgba(0, 1, 0, 1))
	})
})

describe('parseCssColor details', () => {
	it('is case and whitespace insensitive', () => {
		expect(parseCssColor('  #FFF  ')).toEqual(WHITE)
		expect(parseCssColor('OKLCH(1 0 0)')).not.toBeNull()
		expect(parseCssColor('White')).toEqual(WHITE)
	})

	it('accepts deg hues and oklab', () => {
		expectColor(parseCssColor('hsl(120deg 100% 25%)'), 0, 0.5, 0)
		expectColor(
			parseCssColor('oklch(0.623 0.214 259.815deg)'),
			0.169333,
			0.498049,
			1,
		)
		expectColor(parseCssColor('oklab(1 0 0)'), 1, 1, 1)
		expectColor(
			parseCssColor('oklab(0.5 0 0 / 25%)'),
			0.388572,
			0.388572,
			0.388572,
			{
				alpha: 0.25,
			},
		)
	})

	it('reads the legacy comma alpha for rgb and hsl only', () => {
		expectClose(
			parseCssColor('hsl(0, 100%, 50%, 0.3)')?.alpha ?? 0,
			0.3,
			0.0001,
		)
		expect(parseCssColor('oklch(1 0 0 0.3)')?.alpha).toBe(1)
	})

	it('does not treat inherited object keys as named colors', () => {
		expect(parseCssColor('constructor')).toBeNull()
		expect(parseCssColor('tostring')).toBeNull()
	})

	it('wraps negative hsl hues', () => {
		expectColor(parseCssColor('hsl(-240 100% 50%)'), 0, 1, 0)
	})
})

describe('color helpers', () => {
	it('mixes and replaces alpha', () => {
		expect(mixColors(BLACK, WHITE, 0.5)).toEqual(rgba(0.5, 0.5, 0.5))
		expect(mixColors(BLACK, WHITE, 2)).toEqual(WHITE)
		expect(withAlpha(WHITE, 0.5).alpha).toBe(0.5)
		expect(colorsEqual(rgba(1, 1, 1), WHITE)).toBe(true)
		expect(colorsEqual(withAlpha(WHITE, 0.5), WHITE)).toBe(false)
	})

	it('writes the alpha byte only when the color is not opaque', () => {
		expect(toCssHexString(WHITE)).toBe('#ffffff')
		expect(toCssHexString(parseCssColor('#ffffff1a') ?? BLACK)).toBe(
			'#ffffff1a',
		)
		expect(toCssHexString(rgba(1, 0, 0, 0.5))).toBe('#ff000080')
		expect(toCssHexString(rgba(0, 0, 0, 0))).toBe('#00000000')
	})
})

describe('parseSwiftDouble', () => {
	it('accepts what Swift Double(String) accepts', () => {
		expect(parseSwiftDouble('1')).toBe(1)
		expect(parseSwiftDouble('-1.5')).toBe(-1.5)
		expect(parseSwiftDouble('+2')).toBe(2)
		expect(parseSwiftDouble('.5')).toBe(0.5)
		expect(parseSwiftDouble('5.')).toBe(5)
		expect(parseSwiftDouble('1e3')).toBe(1000)
		expect(parseSwiftDouble('0x10')).toBe(16)
		expect(parseSwiftDouble('0x1.8p1')).toBe(3)
		expect(parseSwiftDouble('0')).toBe(0)
		expect(Number.isNaN(parseSwiftDouble('nan'))).toBe(true)
		expect(parseSwiftDouble('inf')).toBe(Infinity)
		expect(parseSwiftDouble('-infinity')).toBe(-Infinity)
	})

	it('rejects what Swift Double(String) rejects', () => {
		expect(parseSwiftDouble('')).toBeNull()
		expect(parseSwiftDouble(' 1')).toBeNull()
		expect(parseSwiftDouble('1 ')).toBeNull()
		expect(parseSwiftDouble('1e')).toBeNull()
		expect(parseSwiftDouble('abc')).toBeNull()
		expect(parseSwiftDouble('Infinity1')).toBeNull()
		expect(parseSwiftDouble('1e999')).toBeNull()
		expect(parseSwiftDouble('1e-999')).toBeNull()
	})
})
