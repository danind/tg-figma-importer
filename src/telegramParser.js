import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import sharp from 'sharp';

const TG_LINK_RE = /t\.me\/(?:s\/)?([A-Za-z0-9_]+)\/(\d+)/i;

export function parseTelegramLink(url) {
  const match = url.match(TG_LINK_RE);
  if (!match) return null;
  return { channel: match[1], messageId: match[2] };
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate',
    },
  });
  const html = await res.text();
  console.log(`[fetchHtml] ${url} -> status ${res.status}, length ${html.length}`);
  return { status: res.status, html };
}

async function toPngBase64(imageUrl) {
  if (!imageUrl) return null;
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const png = await sharp(buf).png().toBuffer();
    return png.toString('base64');
  } catch (e) {
    console.log('[toPngBase64] failed for', imageUrl, e.message);
    return null;
  }
}

function extractBgUrl(style = '') {
  const m = style.match(/url\((?:'|")?(.*?)(?:'|")?\)/);
  return m ? m[1] : null;
}

function parsePercent(styleFragment) {
  if (!styleFragment) return null;
  const m = styleFragment.match(/([\d.]+)%/);
  return m ? parseFloat(m[1]) : null;
}

function styleValue(style, prop) {
  const re = new RegExp(prop + '\\s*:\\s*([\\d.]+%)');
  const m = (style || '').match(re);
  return m ? m[1] : null;
}

// Walks the DOM of the message text block and produces an ordered list of
// "runs" describing plain text (with formatting flags) and custom emoji.
function buildTextRuns($, container) {
  const runs = [];

  function walk(node, style = {}) {
    if (node.type === 'text') {
      const text = $(node).text();
      if (text) runs.push({ type: 'text', text, ...style });
      return;
    }
    if (node.type !== 'tag') return;

    const tag = node.tagName?.toLowerCase();
    const el = $(node);

    if (tag === 'i' && el.hasClass('emoji')) {
      const bgUrl = extractBgUrl(el.attr('style'));
      const fallback = el.find('b').text() || el.text();
      runs.push({ type: 'emoji', imageUrl: bgUrl, fallback });
      return;
    }

    if (tag === 'br') {
      runs.push({ type: 'text', text: '\n' });
      return;
    }

    const nextStyle = { ...style };
    if (tag === 'b' || tag === 'strong') nextStyle.bold = true;
    if (tag === 'i' && !el.hasClass('emoji')) nextStyle.italic = true;
    if (tag === 'u') nextStyle.underline = true;
    if (tag === 's' || tag === 'strike' || tag === 'del') nextStyle.strike = true;
    if (tag === 'code' || tag === 'pre') nextStyle.code = true;
    if (tag === 'tg-spoiler') nextStyle.spoiler = true;
    if (tag === 'a') nextStyle.link = el.attr('href');

    el.contents().each((_, child) => walk(child, nextStyle));
  }

  container.contents().each((_, child) => walk(child, {}));
  return runs;
}

// Tries to find Telegram's grouped-album tiles: elements with an inline
// background-image AND percentage-based width/height (the mosaic layout
// Telegram itself computed for this specific post).
function extractGroupedMedia($) {
  const candidates = [];
  $('[style*="background-image"]').each((_, el) => {
    const style = $(el).attr('style') || '';
    if (/width\s*:\s*[\d.]+%/.test(style) && /height\s*:\s*[\d.]+%/.test(style)) {
      candidates.push(el);
    }
  });

  console.log(`[extractGroupedMedia] found ${candidates.length} percentage-sized bg-image tiles`);

  if (candidates.length < 2) return null;

  const parent = candidates[0].parent;
  const sameParent = candidates.filter((el) => el.parent === parent);
  if (sameParent.length < 2) return null;

  // Try to find the aspect ratio of the whole group from a padding-top trick
  // on the parent or grandparent.
  let groupAspect = null;
  let node = parent;
  for (let i = 0; i < 3 && node && !groupAspect; i++) {
    const style = $(node).attr && $(node).attr('style');
    const pt = styleValue(style, 'padding-top');
    if (pt) groupAspect = parsePercent(pt) / 100;
    node = node.parent;
  }
  if (!groupAspect) groupAspect = 0.66;

  const tiles = sameParent.map((el) => {
    const $el = $(el);
    const style = $el.attr('style') || '';
    return {
      type: /video/i.test($el.attr('class') || '') ? 'video_thumbnail' : 'photo',
      imageUrl: extractBgUrl(style),
      grid: {
        left: parsePercent(styleValue(style, 'left')) || 0,
        top: parsePercent(styleValue(style, 'top')) || 0,
        width: parsePercent(styleValue(style, 'width')) || 100,
        height: parsePercent(styleValue(style, 'height')) || 100,
      },
    };
  });
  tiles.groupAspect = groupAspect;
  return tiles;
}

// Generic heuristic: finds elements whose full text is exactly
// "<one emoji><digits>" — matches Telegram's reaction pills regardless of
// their actual class names.
function extractReactions($) {
  const found = [];
  $('body')
    .find('*')
    .each((_, el) => {
      const txt = $(el).text().trim();
      const m = txt.match(/^(\p{Extended_Pictographic}\uFE0F?)(\d{1,7})$/u);
      if (m) {
        found.push({ emoji: m[1], count: parseInt(m[2], 10), tag: el.tagName, cls: $(el).attr('class') });
      }
    });

  console.log('[extractReactions] candidates:', JSON.stringify(found));

  const seen = new Set();
  return found
    .filter((r) => {
      const key = r.emoji + r.count;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ emoji, count }) => ({ emoji, count }));
}

export async function parseTelegramPost(url) {
  const parsed = parseTelegramLink(url);
  if (!parsed) return { error: 'invalid_link' };

  const embedUrl = `https://t.me/${parsed.channel}/${parsed.messageId}?embed=1`;
  const { status, html } = await fetchHtml(embedUrl);
  const $ = cheerio.load(html);

  const messageBubble = $('.tgme_widget_message').first();
  console.log(`[parseTelegramPost] ${embedUrl} -> httpStatus=${status} bubbleFound=${messageBubble.length}`);

  if (!messageBubble.length) {
    console.log('[parseTelegramPost] html snippet:', html.slice(0, 500));
    return { error: 'private_or_unavailable' };
  }

  // Debug: dump every distinct class name on the page once, to help refine
  // selectors for anything that still looks wrong.
  const allClasses = new Set();
  $('[class]').each((_, el) => {
    ($(el).attr('class') || '').split(/\s+/).forEach((c) => c && allClasses.add(c));
  });
  console.log('[debug] all classes:', Array.from(allClasses).sort().join(' '));

  const channelName =
    $('.tgme_widget_message_owner_name').first().text().trim() ||
    $('.tgme_channel_info_header_title').first().text().trim();

  let avatarUrl = $('.tgme_widget_message_user_photo img').first().attr('src');
  if (!avatarUrl) {
    avatarUrl = extractBgUrl($('.tgme_widget_message_user_photo').first().attr('style'));
  }

  // Use Telegram's own displayed date string instead of reformatting —
  // guarantees an exact visual match.
  const date = $('.tgme_widget_message_date time').first().text().trim() || null;
  const viewsText = $('.tgme_widget_message_views').first().text().trim() || null;

  const textContainer = $('.tgme_widget_message_text').first();
  const runs = textContainer.length ? buildTextRuns($, textContainer) : [];

  let media = extractGroupedMedia($);
  let groupAspect = null;

  if (media) {
    groupAspect = media.groupAspect;
    console.log(`[parseTelegramPost] grouped media: ${media.length} tiles, aspect=${groupAspect}`);
  } else {
    media = [];
    $('.tgme_widget_message_photo_wrap').each((_, el) => {
      const bgUrl = extractBgUrl($(el).attr('style'));
      if (bgUrl) media.push({ type: 'photo', imageUrl: bgUrl });
    });
    $('.tgme_widget_message_video_wrap, .tgme_widget_message_video_player').each((_, el) => {
      const thumb = $(el).find('.tgme_widget_message_video_thumb, video').first();
      let bgUrl = extractBgUrl(thumb.attr('style'));
      if (!bgUrl) bgUrl = thumb.attr('poster');
      if (bgUrl) media.push({ type: 'video_thumbnail', imageUrl: bgUrl });
    });
  }

  const reactions = extractReactions($);

  const avatarBase64 = await toPngBase64(avatarUrl);

  for (const run of runs) {
    if (run.type === 'emoji' && run.imageUrl) {
      run.imageBase64 = await toPngBase64(run.imageUrl);
    }
  }
  for (const m of media) {
    m.imageBase64 = await toPngBase64(m.imageUrl);
  }

  return {
    error: null,
    channel: { name: channelName, avatarBase64 },
    date,
    views: viewsText,
    runs,
    media,
    groupAspect,
    reactions,
  };
}
