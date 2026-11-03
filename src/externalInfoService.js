const WMO_CODES_ID = {
  0: 'Cerah ☀️',
  1: 'Cerah Berawan 🌤️',
  2: 'Berawan Sebagian ⛅',
  3: 'Mendung / Berawan Tebal ☁️',
  45: 'Berkabut 🌫️',
  48: 'Kabut Tebal 🌫️',
  51: 'Gerimis Ringan 🌦️',
  53: 'Gerimis Sedang 🌦️',
  55: 'Gerimis Lebat 🌧️',
  61: 'Hujan Ringan 🌧️',
  63: 'Hujan Sedang 🌧️',
  65: 'Hujan Lebat 🌧️',
  71: 'Salju Ringan ❄️',
  80: 'Hujan Lokal Ringan 🌦️',
  81: 'Hujan Lokal Sedang 🌧️',
  82: 'Hujan Lokal Sangat Deras ⛈️',
  95: 'Hujan Badai / Petir ⛈️',
  96: 'Hujan Petir Disertai Angin Kencang ⛈️',
  99: 'Badai Petir Ekstrem ⛈️'
};

function describeWeatherCode(code) {
  return WMO_CODES_ID[code] || `Kondisi Cuaca (Kode ${code})`;
}

/**
 * Extracts city name from a weather question in Bahasa Indonesia
 */
function extractCityFromWeatherQuery(text) {
  const clean = String(text || '')
    .replace(/[?!.,]/g, ' ')
    .trim();

  // Pattern 1: "cuaca di <kota> ...", "suhu di <kota>", "hujan di <kota>"
  const diMatch = clean.match(
    /\b(?:di|daerah|kota|wilayah|kabupaten|kecamatan)\s+([a-zA-Z\s]{3,30}?)(?:\s+(?:hari\s+ini|sekarang|besok|gimana|bagaimana|berapa|ya|dong|nih|apakah|lagi|saat\s+ini)|$)/i
  );
  if (diMatch && diMatch[1]) {
    return diMatch[1].trim();
  }

  // Pattern 2: "cuaca <kota> hari ini"
  const afterWeatherMatch = clean.match(
    /\b(?:cuaca|suhu|prakiraan\s+cuaca|ramalan\s+cuaca|weather)\s+([a-zA-Z\s]{3,25}?)(?:\s+(?:hari\s+ini|sekarang|besok|gimana|bagaimana|berapa|ya|dong|nih)|$)/i
  );
  if (afterWeatherMatch && afterWeatherMatch[1]) {
    const candidate = afterWeatherMatch[1]
      .replace(/\b(hari|ini|sekarang|besok|lusa|gimana|bagaimana|untuk|di)\b/gi, '')
      .trim();
    if (candidate.length >= 3) return candidate;
  }

  return 'Jakarta';
}

export async function fetchWeatherInfo(questionText) {
  const cityQuery = extractCityFromWeatherQuery(questionText);
  try {
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
      cityQuery
    )}&count=1&language=id&format=json`;
    const geoRes = await fetch(geoUrl, { signal: AbortSignal.timeout(8000) });
    const geoData = await geoRes.json();

    const loc = geoData?.results?.[0];
    if (!loc) {
      return `Data lokasi kota "${cityQuery}" tidak ditemukan di layanan cuaca Open-Meteo.`;
    }

    const forecastUrl = `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FJakarta&forecast_days=3`;
    const fcRes = await fetch(forecastUrl, { signal: AbortSignal.timeout(8000) });
    const fcData = await fcRes.json();

    const cur = fcData?.current || {};
    const daily = fcData?.daily || {};

    let report = `📍 Lokasi: ${loc.name}${loc.admin1 ? `, ${loc.admin1}` : ''}, ${loc.country || 'Indonesia'}\n`;
    report += `🌡️ Kondisi Saat Ini: ${describeWeatherCode(cur.weather_code)}\n`;
    report += `- Suhu: ${cur.temperature_2m}°C (Terasa seperti ${cur.apparent_temperature}°C)\n`;
    report += `- Kelembapan Udara: ${cur.relative_humidity_2m}%\n`;
    report += `- Kecepatan Angin: ${cur.wind_speed_10m} km/jam\n`;

    if (Array.isArray(daily.time) && daily.time.length > 0) {
      report += `\n📅 Prakiraan 3 Hari ke Depan:\n`;
      for (let i = 0; i < daily.time.length; i++) {
        const label = i === 0 ? 'Hari Ini' : i === 1 ? 'Besok' : 'Lusa';
        const dateStr = daily.time[i];
        const cond = describeWeatherCode(daily.weather_code?.[i]);
        const minT = daily.temperature_2m_min?.[i];
        const maxT = daily.temperature_2m_max?.[i];
        const rainProb = daily.precipitation_probability_max?.[i] ?? 0;
        report += `- ${label} (${dateStr}): ${cond} | Suhu ${minT}°C – ${maxT}°C | Peluang Hujan: ${rainProb}%\n`;
      }
    }

    return report;
  } catch (err) {
    return `Gagal mengambil data cuaca untuk ${cityQuery}: ${err.message}`;
  }
}

export async function fetchCurrencyRates() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', {
      signal: AbortSignal.timeout(8000)
    });
    const data = await res.json();
    if (!data?.rates?.IDR) return null;
    const idrPerUsd = data.rates.IDR;
    const currencies = ['USD', 'SGD', 'MYR', 'EUR', 'JPY', 'SAR', 'AUD', 'GBP', 'CNY'];
    const lines = currencies.map((code) => {
      const rateFromUsd = data.rates[code];
      if (!rateFromUsd) return null;
      const inIdr = code === 'USD' ? idrPerUsd : idrPerUsd / rateFromUsd;
      return `1 ${code} = Rp ${Math.round(inIdr).toLocaleString('id-ID')}`;
    });
    return `💱 Kurs Mata Uang Terkini terhadap Rupiah (IDR):\n` + lines.filter(Boolean).join('\n');
  } catch {
    return null;
  }
}

export async function fetchLatestNews(queryText) {
  try {
    const cleanTopic = String(queryText || '')
      .replace(/\b(berita|kabar|info|terbaru|terkini|hari\s+ini|tentang|soal|apa\s+aja|di\s+indonesia)\b/gi, ' ')
      .trim();

    const rssUrl =
      cleanTopic.length >= 3
        ? `https://news.google.com/rss/search?q=${encodeURIComponent(cleanTopic)}&hl=id&gl=ID&ceid=ID:id`
        : `https://news.google.com/rss?hl=id&gl=ID&ceid=ID:id`;

    const res = await fetch(rssUrl, { signal: AbortSignal.timeout(8000) });
    const xml = await res.text();

    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && items.length < 6) {
      const block = match[1];
      const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
      const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      if (titleMatch) {
        const title = titleMatch[1]
          .replace(/<!\[CDATA\[|\]\]>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .trim();
        const pubDate = pubDateMatch ? pubDateMatch[1].trim() : '';
        items.push(`- ${title}${pubDate ? ` (${pubDate})` : ''}`);
      }
    }

    if (items.length === 0) return null;
    return `📰 Berita Terkini Google News Indonesia${cleanTopic ? ` (Topik: ${cleanTopic})` : ''}:\n` + items.join('\n');
  } catch {
    return null;
  }
}

export async function fetchWikipediaInfo(queryText) {
  try {
    const cleanQ = String(queryText || '')
      .replace(/\b(apa\s+itu|siapa\s+itu|jelaskan\s+tentang|info\s+tentang|cari\s+tahu|tolong\s+jelaskan|wikipedia)\b/gi, ' ')
      .replace(/[?!.,]/g, ' ')
      .trim();
    if (cleanQ.length < 2) return null;

    const searchUrl = `https://id.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
      cleanQ
    )}&utf8=&format=json&srlimit=2`;
    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': 'WabotAI/1.0 (https://localhost)' },
      signal: AbortSignal.timeout(7000)
    });
    const data = await res.json();
    const firstHit = data?.query?.search?.[0];
    if (!firstHit?.title) return null;

    const summaryUrl = `https://id.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
      firstHit.title
    )}`;
    const sumRes = await fetch(summaryUrl, {
      headers: { 'User-Agent': 'WabotAI/1.0 (https://localhost)' },
      signal: AbortSignal.timeout(7000)
    });
    const sumData = await sumRes.json();
    if (!sumData?.extract) return null;

    return `📚 Referensi Wikipedia Indonesia (${sumData.title}):\n${sumData.extract}`;
  } catch {
    return null;
  }
}

/**
 * Automatically gathers live external information (weather, currency, news, or Wikipedia)
 * when the user's question requires external real-time knowledge.
 */
export async function gatherExternalKnowledge(questionText = '') {
  const lower = String(questionText || '').toLowerCase();
  if (!lower || lower.length < 3) return '';

  const sections = [];

  // 1. Weather detection
  if (/\b(cuaca|suhu|hujan|mendung|cerah|panas|prakiraan|ramalan\s+cuaca|weather|temperatur)\b/i.test(lower)) {
    const weatherReport = await fetchWeatherInfo(questionText);
    if (weatherReport) sections.push(weatherReport);
  }

  // 2. Currency / Kurs detection
  if (/\b(kurs|nilai\s+tukar|harga\s+dollar|harga\s+dolar|usd|ringgit|myr|sgd|euro|yen|riyal)\b/i.test(lower)) {
    const rates = await fetchCurrencyRates();
    if (rates) sections.push(rates);
  }

  // 3. News detection
  if (/\b(berita|kabar\s+terbaru|headline|berita\s+hari\s+ini|berita\s+terkini|isu\s+terkini)\b/i.test(lower)) {
    const news = await fetchLatestNews(questionText);
    if (news) sections.push(news);
  }

  // 4. Wikipedia lookup for factual questions ("siapa ...", "apa itu ...", "sejarah ...", "dimana letak ...")
  if (
    sections.length === 0 &&
    /\b(apa\s+itu|siapa\s+itu|siapakah|sejarah|biografi|letak|ibukota|presiden|negara|planet|penemu|arti\s+dari|wikipedia)\b/i.test(
      lower
    )
  ) {
    const wiki = await fetchWikipediaInfo(questionText);
    if (wiki) sections.push(wiki);
  }

  return sections.join('\n\n');
}

