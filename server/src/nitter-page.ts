import * as cheerio from 'cheerio';

export function inspectNitterPage(html: string) {
  const $ = cheerio.load(html);
  const content = $('.timeline, .timeline-item, .profile-card, .main-tweet, .conversation').length > 0;
  const home = $('form[action="/search"]').length > 0 && $('nav, .navbar').length > 0;
  const error = $('.error-panel').length > 0;
  const title = $('title').text().trim();
  $('script, style, noscript').remove();
  const text = `${title} ${$('body').text()}`.replace(/\s+/g, ' ').trim().slice(0, 4_000).toLowerCase();
  // Check the document, not just its title: some JS challenges have no title.
  // Conversely, a tweet discussing browser checks must not trigger a refresh.
  const blocked = !content && /you have been blocked by gandalf|you shall not pass|oh noes!/.test(text);
  const challenge = !content && !blocked && /checking your browser|\bverifying\b|making sure you|just a moment|security check|^loading /.test(text);
  return { content, home, error, title, blocked, challenge };
}
