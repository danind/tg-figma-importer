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
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TgFigmaImporter/1.0)' },
  });
  return { status: res.status, html: await res.text() };
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
    return null;
  }
}

function extractBgUrl(style = '') {
  const m = style.match(/url\((?:'|")?(.*?)(?:'|")?\)/);
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

    // Custom / regular emoji are rendered by the web preview as an <i class="emoji">
    // with a background-image (static frame even for animated custom emoji).
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
  const { html } = await fetchHtml(embedUrl);
  const $ = cheerio.load(html);

  const wrap = $('.tgme_widget_message_wrap').first();
  const messageBubble = $('.tgme_widget_message').first();

  // If the widget page doesn't contain the message block, the channel is
  // private / doesn't allow public preview / the post doesn't exist.
  if (!wrap.length || !messageBubble.length) {
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

  // Photos
  $('.tgme_widget_message_photo_wrap').each((_, el) => {
    const bgUrl = extractBgUrl($(el).attr('style'));
    if (bgUrl) media.push({ type: 'photo', imageUrl: bgUrl });
  });

  // Video: only the poster / first-frame thumbnail is taken, never the file itself
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
