import { describe, expect, it } from 'vitest'
import { CATEGORIES, CATEGORY_TAGS, categoryByTag, categoryTagValue, slugify } from '../src/index.ts'

describe('CATEGORIES', () => {
  it('covers every CATEGORY_TAGS value exactly once, in enum order, with the nav handles', () => {
    expect(CATEGORIES.map((c) => c.tag)).toEqual([...CATEGORY_TAGS])
    expect(CATEGORIES.map((c) => c.handle)).toEqual(['toys-play', 'walks-travel', 'beds-comfort', 'grooming-care'])
    expect(CATEGORIES.map((c) => c.title)).toEqual(['Toys & Play', 'Walks & Travel', 'Beds & Comfort', 'Grooming & Care'])
    for (const c of CATEGORIES) {
      expect(c.productType.length).toBeGreaterThan(0)
      expect(c.blurb.length).toBeGreaterThan(10)
    }
  })
  it('categoryByTag / categoryTagValue', () => {
    expect(categoryByTag('beds').handle).toBe('beds-comfort')
    expect(categoryTagValue('toys')).toBe('category:toys')
  })
})

describe('slugify', () => {
  it.each([
    ['Low Noise Pet Hair Clipper - Rechargeable Cordless Dog Grooming Trimmer', 'low-noise-pet-hair-clipper-rechargeable-cordless-dog-groomin'],
    ['Dog Snuff Pad', 'dog-snuff-pad'],
    ['  Café  Pâté — 100% "Organic" Chew!!  ', 'cafe-pate-100-organic-chew'],
    ['---', 'product'],
    ['', 'product'],
    ['狗狗玩具 rope toy', 'rope-toy'],
  ])('%j → %j', (input, expected) => {
    expect(slugify(input)).toBe(expected)
  })
  it('never exceeds 60 chars and never starts/ends with a dash', () => {
    const s = slugify('a'.repeat(100) + '-' + 'b'.repeat(10))
    expect(s.length).toBeLessThanOrEqual(60)
    expect(s).not.toMatch(/^-|-$/)
  })
})
