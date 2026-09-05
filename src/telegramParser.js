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
      // Explicitly avoid Brotli — some versions of node-fetch don't decode it reliably.
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

export async function parseTelegramPost(url) {
  const parsed = parseTelegramLink(url);
  if (!parsed) return { error: 'invalid_link' };

  const embedUrl = `https://t.me/${parsed.channel}/${parsed.messageId}?embed=1`;
  const { status, html } = await fetchHtml(embedUrl);
  const $ = cheerio.load(html);

  const wrap = $('.tgme_widget_message_wrap').first();
  const messageBubble = $('.tgme_widget_message').first();

  console.log(
    `[parseTelegramPost] ${embedUrl} -> httpStatus=${status} wrapFound=${wrap.length} bubbleFound=${messageBubble.length}`
  );

  if (!wrap.length || !messageBubble.length) {
    console.log('[parseTelegramPost] html snippet:', html.slice(0, 500));
    return { error: 'private_or_unavailable' };
  }

  const channelName =
    $('.tgme_widget_message_owner_name').first().text().trim() ||
    $('.tgme_channel_info_header_title').first().text().trim();

  let avatarUrl = $('.tgme_widget_message_user_photo img').first().attr('src');
  if (!avatarUrl) {
    avatarUrl = extractBgUrl($('.tgme_widget_message_user_photo').first().attr('style'));
  }

  const dateEl = $('.tgme_widget_message_date time').first();
  const date = dateEl.attr('datetime') || null;
  const viewsText = $('.tgme_widget_message_views').first().text().trim() || null;

  const textContainer = $('.tgme_widget_message_text').first();
  const runs = textContainer.length ? buildTextRuns($, textContainer) : [];

  const media = [];

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
  };
}
