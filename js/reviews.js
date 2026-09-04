(() => {
  const section = document.getElementById('reviewSection');
  const carousel = document.getElementById('reviewCarousel');
  const track = document.getElementById('reviewTrack');
  if (!section || !carousel || !track) return;

  const SWIPER_DELAY = 2200;
  const SWIPER_SPEED = 1000;
  const RECENT_DAYS = 62;
  const MAX_REVIEWS = 120;

  const IMPORT_KEYWORDS = [
    '메르세데스','벤츠','mercedes','e200','e220','e250','e300','e350','e450','s350','s400','s450','s500','s580','a200','a220','a250','c200','c220','c300','gle','glc','gls','cla','cls','cle','gla','glb','amg','마이바흐',
    'bmw','비엠더블유','1시리즈','2시리즈','3시리즈','4시리즈','5시리즈','6시리즈','7시리즈','8시리즈','x1','x2','x3','x4','x5','x6','x7','xm','i4','i5','i7','ix','z4',
    '아우디','audi','a3','a4','a5','a6','a7','a8','q3','q4','q5','q6','q7','q8','e-tron','etron','이트론','올로드콰트로','콰트로',
    '볼보','volvo','ex30','ex40','ec40','xc40','xc60','xc90','s60','s90','v60','v90',
    '폭스바겐','volkswagen','id.4','id4','id.5','id5','티구안','아테온','투아렉','골프','제타','파사트',
    '포르쉐','porsche','카이엔','마칸','타이칸','파나메라','911','718',
    '랜드로버','레인지로버','land rover','range rover','디펜더','디스커버리','이보크','벨라',
    '렉서스','lexus','es300','es300h','nx','rx','ux','lm','ls',
    '토요타','도요타','toyota','캠리','라브4','rav4','크라운','프리우스','알파드','시에나',
    'mini','미니','쿠퍼','컨트리맨','클럽맨','에이스맨','테슬라','tesla','model y','model 3','model s','model x','모델 y','모델y','모델3','모델s','모델x',
    '폴스타','polestar','지프','jeep','랭글러','그랜드체로키','레니게이드','글래디에이터','포드','ford','익스플로러','브롱코','머스탱','레인저',
    '링컨','lincoln','노틸러스','에비에이터','코세어','네비게이터','캐딜락','cadillac','에스컬레이드','lyriq','리릭','xt4','xt5','xt6',
    '푸조','peugeot','2008','3008','408','5008','마세라티','maserati','그레칼레','기블리','르반떼','콰트로포르테',
    '람보르기니','lamborghini','우루스','우라칸','레부엘토','페라리','ferrari','로마','푸로산게','벤틀리','bentley','벤테이가','컨티넨탈','플라잉스퍼',
    '롤스로이스','rolls-royce','rolls royce','컬리넌','고스트','팬텀','스펙터','byd','비야디','아토3','atto 3','씰','seal','돌핀','dolphin'
  ];

  function importKeywordMatches(haystack, keyword) {
    const needle = String(keyword || '').trim().toLowerCase();
    if (!needle) return false;
    if (/^[a-z]{1,3}\d{1,3}$/i.test(needle)) {
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack);
    }
    return haystack.includes(needle);
  }

  function isImportReview(review) {
    const haystack = `${review?.brand || ''} ${review?.title || ''} ${review?.model || ''}`.toLowerCase();
    return IMPORT_KEYWORDS.some(keyword => importKeywordMatches(haystack, keyword));
  }

  let renderedReviews = [];
  let hiddenAfterBrandSelection = false;
  let reviewSwiper = null;

  const escapeHtml = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

  function parseReviewDate(value) {
    const match = String(value || '').trim().match(/(\d{2,4})[.\/-](\d{1,2})[.\/-](\d{1,2})/);
    if (!match) return null;
    let year = Number(match[1]);
    if (year < 100) year += 2000;
    const date = new Date(year, Number(match[2]) - 1, Number(match[3]));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatReviewDate(value) {
    const date = parseReviewDate(value);
    if (!date) return '';
    return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
  }

  function reviewKey(review) {
    if (review?.id) return String(review.id);
    return String(review?.url || `${review?.title || ''}|${review?.date || ''}`);
  }

  // Actions가 저장한 게시판 순서를 그대로 사용한다. 브라우저에서 재크롤링하거나 날짜순으로 다시 섞지 않는다.
  function prepareReviews(items) {
    const seen = new Set();
    const reviews = [];
    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - RECENT_DAYS);

    for (const review of Array.isArray(items) ? items : []) {
      if (!review?.title || !review?.url) continue;
      if (!isImportReview(review)) continue;
      const reviewDate = parseReviewDate(review.date);
      if (reviewDate && reviewDate < cutoff) continue;
      const key = reviewKey(review);
      if (seen.has(key)) continue;
      seen.add(key);
      reviews.push(review);
      if (reviews.length >= MAX_REVIEWS) break;
    }
    return reviews;
  }

  function detailLines(review) {
    const lines = [];
    if (review.manager) lines.push(`💕💕 담당자 : ${review.manager} 💕💕`);
    if (review.model) lines.push(`차량 모델명 : ${review.model}`);
    if (review.color) lines.push(`색상 : ${review.color}`);
    if (review.method) lines.push(`진행 방식 : ${review.method}`);
    return lines.slice(0, 4);
  }


  function imageMarkup(review) {
    const primary = String(review.image || '').trim();
    if (!primary) return `<div class="review-card__image review-card__image--empty"><span>후기 이미지 준비 중</span></div>`;
    return `<div class="review-card__image">
      <img src="${escapeHtml(primary)}" alt="${escapeHtml(review.title)}" loading="eager" decoding="async" referrerpolicy="no-referrer">
    </div>`;
  }

  function cardTemplate(review) {
    const lines = detailLines(review);
    const date = formatReviewDate(review.date);
    return `<article class="swiper-slide review-card" data-review-id="${escapeHtml(review.id)}">
      <a class="review-card__link" href="${escapeHtml(review.url)}" target="_blank" rel="noopener noreferrer">
        ${imageMarkup(review)}
        <div class="review-card__body">
          <strong class="review-card__title">${escapeHtml(review.title)}</strong>
          ${date ? `<time class="review-card__date" datetime="${escapeHtml(review.date)}">${escapeHtml(date)}</time>` : ''}
          ${lines.length ? `<div class="review-card__details">${lines.map(line => `<p>${escapeHtml(line)}</p>`).join('')}</div>` : ''}
          <span class="review-card__cta">후기 보기</span>
        </div>
      </a>
    </article>`;
  }

  function destroyReviewSwiper() {
    if (!reviewSwiper) return;
    try { reviewSwiper.destroy(true, true); } catch {}
    reviewSwiper = null;
  }

  function initReviewSwiper() {
    destroyReviewSwiper();
    if (hiddenAfterBrandSelection || renderedReviews.length < 2 || typeof window.Swiper !== 'function') return;

    reviewSwiper = new window.Swiper(carousel, {
      slidesPerView: 'auto',
      spaceBetween: 14,
      slidesOffsetBefore: 26,
      slidesOffsetAfter: 26,
      loop: true,
      rewind: false,
      loopAdditionalSlides: Math.min(8, renderedReviews.length),
      loopPreventsSliding: false,
      speed: SWIPER_SPEED,
      grabCursor: true,
      allowTouchMove: true,
      simulateTouch: true,
      followFinger: true,
      threshold: 3,
      touchRatio: 1,
      resistance: true,
      resistanceRatio: 0.72,
      shortSwipes: true,
      longSwipes: true,
      longSwipesRatio: 0.28,
      longSwipesMs: 220,
      watchSlidesProgress: true,
      observer: true,
      observeParents: true,
      autoplay: {
        delay: SWIPER_DELAY,
        disableOnInteraction: false,
        pauseOnMouseEnter: false,
        waitForTransition: true,
        stopOnLastSlide: false
      },
      breakpoints: {
        0: { spaceBetween: 10, slidesOffsetBefore: 14, slidesOffsetAfter: 14 },
        561: { spaceBetween: 12, slidesOffsetBefore: 18, slidesOffsetAfter: 18 },
        821: { spaceBetween: 14, slidesOffsetBefore: 26, slidesOffsetAfter: 26 }
      }
    });
  }

  function bindImageFallbacks() {
    track.querySelectorAll('.review-card__image img').forEach(img => {
      img.addEventListener('load', () => img.closest('.review-card__image')?.classList.add('is-loaded'), { once: true });
      img.addEventListener('error', () => {
        const slot = img.closest('.review-card__image');
        if (slot) {
          slot.classList.add('review-card__image--empty');
          slot.innerHTML = '<span>후기 이미지 준비 중</span>';
        }
      }, { once: true });
    });
  }

  function renderReviewList(items) {
    renderedReviews = prepareReviews(items);
    if (!renderedReviews.length) {
      section.hidden = true;
      destroyReviewSwiper();
      return;
    }
    if (hiddenAfterBrandSelection) {
      section.hidden = true;
      destroyReviewSwiper();
      return;
    }
    section.hidden = false;
    track.innerHTML = renderedReviews.map(cardTemplate).join('');
    bindImageFallbacks();
    requestAnimationFrame(() => requestAnimationFrame(initReviewSwiper));
  }

  function restoreReviewSection() {
    hiddenAfterBrandSelection = false;
    if (!renderedReviews.length) return;
    section.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      initReviewSwiper();
      reviewSwiper?.slideToLoop?.(0, 0, false);
      reviewSwiper?.autoplay?.start?.();
    }));
  }

  async function loadReviews() {
    try {
      const response = await fetch(`data/reviews.json?v=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      renderReviewList(Array.isArray(payload) ? payload : payload.reviews || []);
    } catch (error) {
      console.warn('수입차 후기 데이터를 불러오지 못했습니다.', error);
      section.hidden = true;
    }
  }

  document.addEventListener('click', event => {
    const brandButton = event.target.closest?.('.wizard-brand-grid button[data-brand]');
    if (!brandButton) return;
    hiddenAfterBrandSelection = true;
    section.hidden = true;
    reviewSwiper?.autoplay?.stop?.();
    destroyReviewSwiper();
  }, true);

  document.addEventListener('autogenie:wizard-reset', restoreReviewSection);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !hiddenAfterBrandSelection) reviewSwiper?.autoplay?.start?.();
  });

  loadReviews();
})();
