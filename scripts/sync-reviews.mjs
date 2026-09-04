import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const SOURCE = 'https://www.agautoplan.com/review';
const RECENT_DAYS = 62;
const MAX_PAGES = 30;
const MAX_REVIEWS = 120;
const OUTPUT = path.resolve('data/reviews.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function koreaToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const value = type => Number(parts.find(part => part.type === type)?.value || 0);
  return new Date(value('year'), value('month') - 1, value('day'));
}

function parseRelativeDate(text = '') {
  const value = clean(text);
  if (!value) return null;

  const today = koreaToday();

  if (/오늘|방금|\d+\s*(?:분|시간)\s*전/.test(value)) {
    return today;
  }

  if (/어제/.test(value)) {
    today.setDate(today.getDate() - 1);
    return today;
  }

  const daysAgo = value.match(/(\d+)\s*일\s*전/);
  if (daysAgo) {
    today.setDate(today.getDate() - Number(daysAgo[1]));
    return today;
  }

  return null;
}

function parseDate(text = '') {
  const value = String(text || '');
  const patterns = [
    { re: /(20\d{2})\s*[.\/-]\s*(\d{1,2})\s*[.\/-]\s*(\d{1,2})/, shortYear: false },
    { re: /(20\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/, shortYear: false },
    // 아임웹이 최신 글 날짜를 26.09.03처럼 2자리 연도로 표시하는 경우 대응
    { re: /(?:^|\D)(\d{2})\s*[.\/-]\s*(\d{1,2})\s*[.\/-]\s*(\d{1,2})(?:\D|$)/, shortYear: true }
  ];

  for (const { re, shortYear } of patterns) {
    const m = value.match(re);
    if (!m) continue;
    const year = shortYear ? 2000 + Number(m[1]) : Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const d = new Date(year, month - 1, day);
    if (
      !Number.isNaN(d.getTime()) &&
      d.getFullYear() === year &&
      d.getMonth() === month - 1 &&
      d.getDate() === day
    ) return d;
  }

  return parseRelativeDate(value);
}

function parseImageDate(url = '') {
  // 날짜 텍스트가 DOM에 없을 때 아임웹 업로드/썸네일 경로의 YYYYMMDD를 최후 보조값으로 사용한다.
  const m = String(url || '').match(/\/(?:upload|thumbnail)\/(20\d{2})(\d{2})(\d{2})\//i);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(year, month - 1, day);
  if (
    Number.isNaN(d.getTime()) ||
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day
  ) return null;
  return d;
}

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function clean(s='') {
  return String(s).replace(/\s+/g, ' ').trim();
}

function labelValue(text, label) {
  const re = new RegExp(`${label}\\s*[:：]\\s*([^\\n\\r]{1,160})`, 'i');
  return clean(text.match(re)?.[1] || '');
}

function guessBrand(text='') {
  const brands = [
    '현대','기아','제네시스','르노','KGM','쉐보레','벤츠','메르세데스','BMW',
    '아우디','볼보','폭스바겐','포르쉐','랜드로버','레인지로버','렉서스','토요타',
    '미니','MINI','테슬라','폴스타','지프','포드','링컨','캐딜락','푸조','마세라티',
    '벤틀리','롤스로이스','BYD'
  ];
  const lower = String(text).toLowerCase();
  return brands.find(b => lower.includes(b.toLowerCase())) || '';
}

function isInvalidTitle(value='') {
  const title = clean(value);
  if (!title) return true;
  return /접속할\s*수\s*없|페이지를\s*찾을\s*수\s*없|찾을\s*수\s*없|오류|error|not\s*found|없어요/i.test(title);
}

function normalizeReviewTitle(value='') {
  const title = clean(value)
    .replace(/^(?:\[?공지\]?|NOTICE)\s*[:：-]?\s*/i, '')
    .trim();
  return isInvalidTitle(title) ? '' : title;
}

async function collectCurrentPageItems(page) {
  return await page.evaluate(() => {
    const result = [];
    const seen = new Set();
    const anchors = [...document.querySelectorAll('a[href*="bmode=view"][href*="idx="]')];

    const abs = raw => {
      if (!raw) return '';
      try { return new URL(raw, location.href).href; } catch { return String(raw); }
    };

    const pickTitle = (a, card) => {
      const candidates = [
        a.getAttribute('title'),
        a.getAttribute('aria-label'),
        ...[...card.querySelectorAll('h1,h2,h3,h4,h5,.title,[class*="title"],strong,b')].map(el => el.textContent),
        a.textContent
      ].filter(Boolean).map(s => String(s).replace(/\s+/g, ' ').trim());

      return candidates.find(t => /출고\s*후기/.test(t)) || '';
    };

    for (const a of anchors) {
      const href = (a.getAttribute('href') || '').replace(/&amp;/g, '&');
      const id = href.match(/[?&]idx=(\d+)/)?.[1];
      if (!id || seen.has(id)) continue;

      const style = getComputedStyle(a);
      const rect = a.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) continue;

      const card =
        a.closest('li,article,tr,.list-style,.board-list,.board_list,.card,.item,[class*="board_item"],[class*="list_item"]') ||
        a.parentElement ||
        a;

      const text = (card.innerText || '').trim();
      const title = pickTitle(a, card);
      const imageCandidates = [];
      const pushImage = (raw, score = 0) => {
        const url = abs(raw);
        if (!url) return;
        const lower = url.toLowerCase();
        if (/logo|icon|profile|avatar|favicon|loading|spinner|blank|transparent|placeholder/.test(lower)) return;
        if (/cdn\.imweb\.me\/upload|imweb\.me\/upload/.test(lower)) score += 300000;
        if (/thumbnail/.test(lower)) score -= 50000;
        imageCandidates.push({ url, score });
      };

      for (const img of card.querySelectorAll('img')) {
        const rect = img.getBoundingClientRect();
        const width = Math.max(img.naturalWidth || 0, rect.width || 0, Number(img.getAttribute('width')) || 0);
        const height = Math.max(img.naturalHeight || 0, rect.height || 0, Number(img.getAttribute('height')) || 0);

        if (width && height && (width < 160 || height < 90)) continue;

        let score = Math.min(width * height, 5_000_000);
        if (width >= 300) score += 250000;
        if (height >= 160) score += 200000;

        [
          img.currentSrc,
          img.getAttribute('data-src'),
          img.getAttribute('data-original'),
          img.getAttribute('data-lazy-src'),
          img.getAttribute('data-image'),
          img.getAttribute('src'),
          img.getAttribute('srcset')
        ].filter(Boolean).forEach(raw => pushImage(raw, score));
      }

      for (const el of card.querySelectorAll('[style*="background"]')) {
        const bg = getComputedStyle(el).backgroundImage || el.style.backgroundImage || '';
        const match = bg.match(/url\(["']?(.*?)["']?\)/i);
        if (!match?.[1]) continue;

        const rect = el.getBoundingClientRect();
        if (rect.width && rect.height && (rect.width < 160 || rect.height < 90)) continue;

        let score = Math.min((rect.width || 0) * (rect.height || 0), 5_000_000) + 100000;
        pushImage(match[1], score);
      }

      imageCandidates.sort((a, b) => b.score - a.score);
      const image = imageCandidates[0]?.url || '';

      seen.add(id);
      result.push({ id, href: abs(href), text, title, image });
    }

    return result;
  });
}

async function clickNextListPage(page, currentPageNo) {
  const target = currentPageNo + 1;
  return await page.evaluate((target) => {
    const candidates = [...document.querySelectorAll('a,button')].filter(el => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    });

    const exact = candidates.find(el => (el.textContent || '').trim() === String(target));
    if (exact) {
      exact.click();
      return true;
    }

    const next = candidates.find(el => {
      const txt = (el.textContent || '').trim();
      const aria = el.getAttribute('aria-label') || '';
      const cls = String(el.className || '');
      return /^(다음|next|›|»|>)$/i.test(txt) || /next|다음/i.test(`${aria} ${cls}`);
    });

    if (next) {
      next.click();
      return true;
    }
    return false;
  }, target);
}

async function collectBoardOrder(page) {
  const ordered = [];
  const seen = new Set();

  await page.goto(SOURCE, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2400);

  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);

    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(500);
    }

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);

    const items = await collectCurrentPageItems(page);
    console.log(`목록 ${pageNo}페이지: ${items.length}건`);

    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      ordered.push({
        ...item,
        listDate: parseDate(item.text),
        sourceOrder: ordered.length
      });
    }

    if (!items.length) break;

    // 목록에 날짜가 충분히 잡히면 최근 62일을 벗어난 시점에서 더 오래된 페이지 탐색을 중단한다.
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RECENT_DAYS);
    cutoff.setHours(0, 0, 0, 0);

    const pageDates = items.map(item => parseDate(item.text)).filter(Boolean);
    if (pageDates.length && pageDates.every(date => date < cutoff)) {
      console.log(`목록 ${pageNo}페이지에서 최근 ${RECENT_DAYS}일 범위를 벗어나 탐색 종료`);
      break;
    }

    const clicked = await clickNextListPage(page, pageNo);
    if (!clicked) break;
    await page.waitForTimeout(1800);
  }

  return ordered;
}


function normalizeImageCandidate(raw = '') {
  let value = String(raw || '')
    .replace(/\\u002F/gi, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .trim();

  if (!value) return '';
  try { value = decodeURIComponent(value); } catch {}
  value = value.replace(/["'<>),;]+$/g, '');
  if (value.startsWith('//')) value = `https:${value}`;
  return value;
}

function isJunkImageUrl(raw = '') {
  const lower = normalizeImageCandidate(raw).toLowerCase();
  return !lower ||
    /logo|icon|profile|avatar|favicon|loading|spinner|blank|transparent|placeholder|og-image|screenshot|car-img-bg|vehicle-stage-bg/.test(lower) ||
    lower.startsWith('data:image/svg') || lower.startsWith('data:image/gif');
}

function scoreImageUrl(raw = '') {
  const url = normalizeImageCandidate(raw);
  if (!url || isJunkImageUrl(url)) return -Infinity;
  let score = 0;
  if (/cdn\.imweb\.me\/upload\//i.test(url)) score += 5000;
  else if (/cdn\.imweb\.me\/thumbnail\//i.test(url)) score += 3000;
  else if (/imweb|cdn|upload|files|image/i.test(url)) score += 900;
  if (/\.(?:jpe?g|png|webp|avif)(?:\?|$)/i.test(url)) score += 500;
  if (/thumbnail/i.test(url)) score -= 250;
  return score;
}

function pickBestImageUrl(candidates = []) {
  return [...new Set(candidates.map(normalizeImageCandidate).filter(Boolean))]
    .filter(url => !isJunkImageUrl(url))
    .map(url => ({ url, score: scoreImageUrl(url) }))
    .sort((a, b) => b.score - a.score)[0]?.url || '';
}

function extractImwebImagesFromHtml(html = '') {
  let source = String(html || '')
    .replace(/\\u002F/gi, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&');

  // URL encoded script/JSON 안의 CDN 주소도 한 번 더 펼친다.
  try { source += `\n${decodeURIComponent(source)}`; } catch {}

  const urls = [];
  const patterns = [
    /https?:\/\/cdn\.imweb\.me\/(?:upload|thumbnail)\/[^\s"'<>\\)]+/gi,
    /\/\/cdn\.imweb\.me\/(?:upload|thumbnail)\/[^\s"'<>\\)]+/gi,
    /https?%3A%2F%2Fcdn\.imweb\.me%2F(?:upload|thumbnail)%2F[^\s"'<>]+/gi,
    /https?:\/\/[^\s"'<>\\)]+\.(?:jpe?g|png|webp|avif)(?:\?[^\s"'<>\\)]*)?/gi
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const url = normalizeImageCandidate(match[0]);
      if (!url || isJunkImageUrl(url)) continue;
      urls.push(url);
    }
  }
  return [...new Set(urls)];
}

function extractImwebImageFromHtml(html = '') {
  return pickBestImageUrl(extractImwebImagesFromHtml(html));
}

async function collectRuntimeImageCandidates(page) {
  return await page.evaluate(() => {
    const values = [];
    const add = raw => { if (raw) values.push(String(raw)); };

    for (const entry of performance.getEntriesByType('resource')) add(entry.name);

    for (const img of document.querySelectorAll('img')) {
      add(img.currentSrc); add(img.src); add(img.srcset);
      for (const attr of img.attributes || []) add(attr.value);
    }
    for (const source of document.querySelectorAll('picture source, source[srcset]')) {
      add(source.getAttribute('src')); add(source.getAttribute('srcset'));
      for (const attr of source.attributes || []) add(attr.value);
    }

    for (const el of document.querySelectorAll('*')) {
      for (const attr of el.attributes || []) add(attr.value);
      const style = getComputedStyle(el);
      add(style.backgroundImage);
      add(style.content);
      for (let i = 0; i < style.length; i += 1) {
        const name = style[i];
        if (name?.startsWith('--')) add(style.getPropertyValue(name));
      }
    }

    for (const script of document.scripts) add(script.textContent);
    return values;
  }).catch(() => []);
}

async function parseDetail(page, item) {
  const { id, sourceOrder } = item;
  const url = item.href || `${SOURCE}/?bmode=view&idx=${id}`;

  let data = { text: '', title: '', image: '' };

  // DOM/HTML에 남지 않는 아임웹 지연 로딩 이미지도 실제 네트워크 요청에서 잡는다.
  const networkImages = new Set();
  const onRequest = request => {
    try {
      const requestUrl = request.url();
      if (/cdn\.imweb\.me\/(?:upload|thumbnail)\//i.test(requestUrl) && !isJunkImageUrl(requestUrl)) {
        networkImages.add(requestUrl);
      }
    } catch {}
  };
  const onResponse = response => {
    try {
      const responseUrl = response.url();
      const contentType = response.headers()['content-type'] || '';
      if (!/cdn\.imweb\.me\/(?:upload|thumbnail)\//i.test(responseUrl)) return;
      if (!/^image\//i.test(contentType) && !/\.(?:jpe?g|png|webp|gif)(?:\?|$)/i.test(responseUrl)) return;
      if (/logo|icon|profile|avatar|favicon|loading|spinner|blank|transparent|placeholder/i.test(responseUrl)) return;
      networkImages.add(responseUrl);
    } catch {}
  };
  page.on('request', onRequest);
  page.on('response', onResponse);

  try {
    const canonicalUrl = `${SOURCE}/?bmode=view&idx=${id}`;
    const targets = [...new Set([url, canonicalUrl])];

    // 목록 URL에 검색 파라미터가 붙어 있거나 첫 로딩이 불완전한 경우를 대비해 canonical URL까지 재시도한다.
    for (let attempt = 0; attempt < targets.length; attempt += 1) {
      await page.goto(targets[attempt], { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(attempt === 0 ? 850 : 1200);

      // lazy-load, IntersectionObserver, background-image 등을 모두 발화시키기 위해 페이지 전체를 비율로 훑는다.
      for (const ratio of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
        await page.evaluate(r => window.scrollTo(0, Math.max(0, (document.body.scrollHeight - innerHeight) * r)), ratio);
        await page.waitForTimeout(260);
      }
      await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => {});
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(300);
      if (networkImages.size) break;
    }

    data = await page.evaluate(() => {
      const text = document.body?.innerText || '';

      const titleCandidates = [
        document.querySelector('.board_view .title')?.textContent,
        document.querySelector('.board_view [class*="title"]')?.textContent,
        document.querySelector('.board_txt_area h1')?.textContent,
        document.querySelector('.board_txt_area h2')?.textContent,
        document.querySelector('.board_txt_area h3')?.textContent,
        document.querySelector('[class*="board_title"]')?.textContent,
        document.querySelector('h1')?.textContent,
        document.querySelector('h2')?.textContent,
        document.title
      ].filter(Boolean).map(s => String(s).replace(/\s+/g, ' ').trim());

      const title = titleCandidates.find(t => /출고\s*후기/.test(t)) || titleCandidates[0] || '';

      const roots = [
        document.querySelector('.board_txt_area'),
        document.querySelector('.board_view_body'),
        document.querySelector('.board_view'),
        document.querySelector('[class*="board_view"]'),
        document.querySelector('article'),
        document.querySelector('main')
      ].filter(Boolean);

      const root = roots[0] || document.body;

      const normalizeUrl = raw => {
        if (!raw) return '';
        let value = String(raw).trim();
        if (!value) return '';
        if (value.includes(',')) value = value.split(',').pop().trim();
        value = value.split(/\s+/)[0];
        try { return new URL(value, location.href).href; } catch { return value; }
      };

      const isJunk = url => {
        const lower = String(url || '').toLowerCase();
        return !lower ||
          /logo|icon|profile|avatar|favicon|loading|spinner|blank|transparent|placeholder/.test(lower) ||
          /car-img-bg|vehicle-stage-bg/.test(lower) ||
          lower.startsWith('data:image/svg');
      };

      const candidates = [];

      for (const img of root.querySelectorAll('img')) {
        const attrs = [
          img.currentSrc,
          img.getAttribute('data-src'),
          img.getAttribute('data-original'),
          img.getAttribute('data-lazy-src'),
          img.getAttribute('data-image'),
          img.getAttribute('src'),
          img.getAttribute('data-srcset'),
          img.getAttribute('srcset')
        ];

        const urls = [...new Set(attrs.map(normalizeUrl).filter(Boolean))];
        const rect = img.getBoundingClientRect();
        const width = Math.max(img.naturalWidth || 0, rect.width || 0, Number(img.getAttribute('width')) || 0);
        const height = Math.max(img.naturalHeight || 0, rect.height || 0, Number(img.getAttribute('height')) || 0);

        for (const imageUrl of urls) {
          if (isJunk(imageUrl)) continue;

          let score = Math.min(width * height, 5_000_000);
          if (/imweb|cdn|upload|files|image/i.test(imageUrl)) score += 500_000;
          if (width >= 500) score += 400_000;
          if (height >= 300) score += 300_000;
          if (img.closest('.board_txt_area,.board_view,.board_view_body,[class*="board_view"]')) score += 1_000_000;

          candidates.push({ url: imageUrl, score });
        }
      }

      for (const el of root.querySelectorAll('[style*="background"]')) {
        const bg = getComputedStyle(el).backgroundImage || el.style.backgroundImage || '';
        const match = bg.match(/url\(["']?(.*?)["']?\)/i);
        const imageUrl = normalizeUrl(match?.[1] || '');
        if (!imageUrl || isJunk(imageUrl)) continue;

        const rect = el.getBoundingClientRect();
        const score = Math.min((rect.width || 0) * (rect.height || 0), 5_000_000) + 600_000;
        candidates.push({ url: imageUrl, score });
      }

      // img 태그가 아닌 요소의 data-* / href / content 속성에 원본 이미지가 들어가는 아임웹 스킨 대응.
      for (const el of document.querySelectorAll('*')) {
        for (const attr of el.attributes || []) {
          const raw = attr.value || '';
          if (!/cdn\.imweb\.me\/(?:upload|thumbnail)\//i.test(raw)) continue;
          const matches = raw.match(/https?:\/\/cdn\.imweb\.me\/(?:upload|thumbnail)\/[^\"'<>\s)]+/gi) || [];
          for (const match of matches) {
            const imageUrl = normalizeUrl(match.replace(/\\\//g, '/'));
            if (!imageUrl || isJunk(imageUrl)) continue;
            let score = /\/upload\//i.test(imageUrl) ? 1_350_000 : 950_000;
            if (/\.(?:jpe?g|png|webp)(?:\?|$)/i.test(imageUrl)) score += 250_000;
            candidates.push({ url: imageUrl, score });
          }
        }
      }

      candidates.sort((a, b) => b.score - a.score);

      return {
        text,
        title,
        image: candidates[0]?.url || ''
      };
    });

    // DOM 밖의 picture/source, CSS 변수, script JSON, Performance Resource까지 한 번에 훑는다.
    if (!data.image) {
      const runtimeValues = await collectRuntimeImageCandidates(page);
      const runtimeUrls = runtimeValues.flatMap(value => extractImwebImagesFromHtml(value));
      data.image = pickBestImageUrl(runtimeUrls);
      if (data.image) console.log(`[이미지 RUNTIME fallback] #${sourceOrder} ${id}`);
    }

    // 렌더링 HTML/스크립트 원문에 남은 CDN URL 추출.
    if (!data.image) {
      const html = await page.content().catch(() => '');
      data.image = extractImwebImageFromHtml(html);
      if (data.image) console.log(`[이미지 HTML fallback] #${sourceOrder} ${id}`);
    }

    // 브라우저가 실제로 요청한 이미지. request + response를 모두 수집한다.
    if (!data.image && networkImages.size) {
      data.image = pickBestImageUrl([...networkImages]);
      if (data.image) console.log(`[이미지 NETWORK fallback] #${sourceOrder} ${id}`);
    }

    // 브라우저 DOM이 불완전해도 서버 원문에는 주소가 있을 수 있어 canonical 상세 HTML을 직접 한 번 더 읽는다.
    if (!data.image) {
      const canonicalUrl = `${SOURCE}/?bmode=view&idx=${id}`;
      try {
        const response = await page.context().request.get(canonicalUrl, { timeout: 15000 });
        if (response.ok()) {
          const rawHtml = await response.text();
          data.image = extractImwebImageFromHtml(rawHtml);
          if (data.image) console.log(`[이미지 DIRECT-HTML fallback] #${sourceOrder} ${id}`);
        }
      } catch {}
    }
  } catch (error) {
    console.warn(`[상세 보조] ${id} 상세페이지 로드 실패: ${error.message}`);
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
  }

  const combinedText = `${data.text || ''}\n${item.text || ''}`;

  let date =
    parseDate(data.text) ||
    item.listDate ||
    parseDate(item.text);

  if (!date) {
    date = parseImageDate(item.image) || parseImageDate(data.image);
    if (date) {
      console.warn(`[날짜 보조] #${sourceOrder} id=${id} 날짜 텍스트가 없어 이미지 경로 날짜 ${isoDate(date)} 사용`);
    }
  }

  if (!date) {
    console.warn(`[건너뜀] #${sourceOrder} id=${id} 날짜를 상세/목록/이미지 경로 어디에서도 찾지 못함`);
    return null;
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RECENT_DAYS);
  cutoff.setHours(0, 0, 0, 0);

  if (date < cutoff) {
    return { tooOld: true, date };
  }

  const model =
    labelValue(combinedText, '차량 모델명') ||
    clean(item.title).replace(/\s*출고\s*후기.*$/,'').trim();

  const validDetailTitle = normalizeReviewTitle(data.title);
  const validListTitle = normalizeReviewTitle(item.title);

  let title =
    validDetailTitle ||
    validListTitle ||
    normalizeReviewTitle(combinedText.split(/\n+/).find(line => /출고\s*후기/.test(line)) || '');

  title = normalizeReviewTitle(title);
  if (isInvalidTitle(title) || !title) {
    title = model ? `${model} 출고 후기입니다.` : '오토지니 출고 후기입니다.';
  }

  // 목록 카드 썸네일을 우선 사용하고, 없거나 비정상일 때 상세페이지 이미지를 사용한다.
  const listImage = normalizeImageCandidate(item.image || '');
  const image = !isJunkImageUrl(listImage) ? listImage : (data.image || '');

  return {
    id: String(id),
    title,
    brand: guessBrand(`${title} ${model}`),
    model,
    manager: labelValue(combinedText, '담당자'),
    color: labelValue(combinedText, '색상'),
    method: labelValue(combinedText, '진행 방식'),
    date: isoDate(date),
    image,
    url,
    sourceOrder
  };
}

const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({
    locale: 'ko-KR',
    viewport: { width: 1440, height: 1800 }
  });

  const listPage = await context.newPage();

  console.log('오토지니 후기 게시판 최신 목록 순서 수집 시작');

  const items = await collectBoardOrder(listPage);

  console.log(`게시판 DOM 순서 기준 후기 ${items.length}개 발견`);

  if (!items.length) {
    throw new Error('후기 게시글을 찾지 못했습니다.');
  }

  const detailPage = await context.newPage();
  const reviews = [];

  for (let i = 0; i < items.length && reviews.length < MAX_REVIEWS; i++) {
    const parsed = await parseDetail(detailPage, items[i]);

    if (parsed?.tooOld) {
      console.log(`최근 ${RECENT_DAYS}일 범위 종료 지점: ${isoDate(parsed.date)}`);
      break;
    }

    if (parsed) {
      parsed.title = normalizeReviewTitle(parsed.title) || parsed.title;
      reviews.push(parsed);
      console.log(`[${reviews.length}] #${parsed.sourceOrder} ${parsed.date} ${parsed.title}`);
    }

    await sleep(180);
  }

  if (!reviews.length) {
    throw new Error('최근 2개월 후기를 한 건도 수집하지 못했습니다.');
  }

  const unique = [];
  const seen = new Set();

  for (const review of reviews) {
    if (seen.has(review.id)) continue;
    seen.add(review.id);
    unique.push(review);
  }

  const firstOrder = unique[0]?.sourceOrder;

  if (firstOrder !== 0) {
    throw new Error(`최신 후기 누락 감지: 첫 저장 후기 sourceOrder=${firstOrder}. 최신 글을 건너뛴 상태라 stale JSON 저장을 중단합니다.`);
  }

  const invalidSavedTitles = unique.filter(review => isInvalidTitle(review.title));
  if (invalidSavedTitles.length) {
    throw new Error(`오류 페이지 제목이 ${invalidSavedTitles.length}건 남아 있어 reviews.json 저장을 중단합니다.`);
  }

  const missingImages = unique.filter(review => !review.image);
  if (missingImages.length) {
    console.warn(`⚠ 이미지 누락 ${missingImages.length}건: ${missingImages.map(r => `${r.date} #${r.id} ${r.title}`).join(' | ')}`);
  } else {
    console.log('이미지 누락 0건');
  }

  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });

  await fs.writeFile(
    OUTPUT,
    JSON.stringify({
      source: SOURCE,
      generatedAt: new Date().toISOString(),
      recentDays: RECENT_DAYS,
      order: 'board-visible-order-newest-first',
      count: unique.length,
      reviews: unique
    }, null, 2) + '\n',
    'utf8'
  );

  console.log(`완료: 후기 카테고리 최신 화면 순서 그대로 최근 ${RECENT_DAYS}일 ${unique.length}건 저장`);
} finally {
  await browser.close();
}
