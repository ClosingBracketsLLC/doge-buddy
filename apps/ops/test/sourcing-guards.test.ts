import { describe, expect, it } from 'vitest'
import { matchExcludedCategory, findClaimViolations, htmlToText, validateDescriptionHtml } from '../src/sourcing/guards'

describe('guards', () => {
  it('matchExcludedCategory hits on any text field, case-insensitively', () => {
    expect(matchExcludedCategory('Dog CALMING Bed', 'Beds')).toBe('calming')
    expect(matchExcludedCategory('Rope Toy', 'Pet Toys')).toBeNull()
    expect(matchExcludedCategory(undefined, 'Flea & Tick Collar')).toBe('flea')
  })
  it('findClaimViolations returns every hit', () => {
    expect(findClaimViolations('Vet Approved shampoo', '<p>clinically proven pain relief</p>')).toEqual(
      expect.arrayContaining(['vet approved', 'clinically proven', 'pain relief']),
    )
    expect(findClaimViolations('Durable rope toy for strong chewers... just kidding, tug rope')).toEqual([])
  })
  it('htmlToText strips tags for scanning', () => {
    expect(htmlToText('<p>anxiety <strong>relief</strong></p>')).toBe('anxiety relief')
  })
  describe('validateDescriptionHtml', () => {
    it.each([
      ['<p>Good <strong>toy</strong></p><ul><li>durable</li></ul>', null],
      ['<h2>Specs</h2><p>10cm</p>', null],
    ])('accepts %s', (html, expected) => expect(validateDescriptionHtml(html)).toBe(expected))
    it.each([
      '<script>alert(1)</script>',
      '<p onclick="x">hi</p>',
      '<img src="x">',
      '<a href="javascript:alert(1)">x</a>',
      '<p>see data:text/html;base64,x</p>',
      '<iframe src="https://x"></iframe>',
      '<P STYLE="x">shout</P>',
    ])('rejects %s', (html) => expect(validateDescriptionHtml(html)).not.toBeNull())
  })
})
