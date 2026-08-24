import { describe, expect, it } from 'vitest'
import { matchExcludedCategory, findClaimViolations, htmlToText, validateDescriptionHtml } from '../src/sourcing/guards.js'

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
  describe('FIX C3: htmlToText decodes numeric/hex entities so the claims + category scans see them', () => {
    it('decodes decimal and hex character references', () => {
      expect(htmlToText('&#99;at &#x64;og')).toBe('cat dog')
    })
    it('single-pass safety: &amp;#99; stays literal, does not double-decode into "c"', () => {
      expect(htmlToText('&amp;#99;')).toBe('&#99;')
    })
    it('does not crash on an out-of-range numeric reference', () => {
      expect(() => htmlToText('<p>&#999999999;ok</p>')).not.toThrow()
    })
    it('findClaimViolations catches a claim term hidden behind decimal entities', () => {
      // '<p>&#99;ures &#97;nxiety</p>' -> 'cures anxiety'; 'cures' is a disallowed claim phrase.
      expect(findClaimViolations(htmlToText('<p>&#99;ures &#97;nxiety</p>'))).toContain('cures')
    })
    it('matchExcludedCategory catches an excluded term hidden behind decimal entities', () => {
      // Same decoded text — 'anxiety' is an excluded-category term.
      expect(matchExcludedCategory(htmlToText('<p>&#99;ures &#97;nxiety</p>'))).toBe('anxiety')
    })
    it('matchExcludedCategory catches an excluded term hidden behind a hex entity', () => {
      expect(matchExcludedCategory(htmlToText('<p>&#x63;alming bed</p>'))).toBe('calming')
    })
  })
  describe('validateDescriptionHtml', () => {
    it.each([
      ['<p>Good <strong>toy</strong></p><ul><li>durable</li></ul>', null],
      ['<h2>Specs</h2><p>10cm</p>', null],
      ['<p>price < 100 dogs</p>', null],
      ['<p>rated <3 by pups</p>', null],
      ['<p>Our data : verified from three labs</p>', null],
      ['<p>Our data\n: verified</p>', null],
      ['<p>See the data on our site</p>', null],
      ['<p>Our metadata: fields are verified</p>', null],
      ['<p>Product metadata: verified across three independent labs</p>', null],
      ['<p>See userdata: handled securely by our vendor</p>', null],
    ])('accepts %s', (html, expected) => expect(validateDescriptionHtml(html)).toBe(expected))
    it.each([
      '<script>alert(1)</script>',
      '<p onclick="x">hi</p>',
      '<img src="x">',
      '<a href="javascript:alert(1)">x</a>',
      '<p>see data:text/html;base64,x</p>',
      '<iframe src="https://x"></iframe>',
      '<P STYLE="x">shout</P>',
      '<p>hi</p><script',
      '<p>x</p></',
      '<!-- hidden -->',
      '<p>see &#106;avascript:alert(1)</p>',
      '<p>&#x64;ata:text/html,x</p>',
      '<p>java\nscript:alert(1)</p>',
      '<p>java\tscript:x</p>',
      '<ѕcript>x</ѕcript>',
      '<p>java​script:alert(1)</p>',  // zero-width space U+200B
      '<p>da​ta:text/html,x</p>',   // zero-width space U+200B
    ])('rejects %s', (html) => expect(validateDescriptionHtml(html)).not.toBeNull())
    it('rejects tight less-than comparisons by design — descriptionHtml is real HTML, author must escape < as &lt;', () => {
      expect(validateDescriptionHtml('<p>works when a<b in size</p>')).not.toBeNull()
    })
  })
})
