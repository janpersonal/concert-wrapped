// Cloudflare Worker: private search proxy for the concert tracker.
// Secrets to add (Settings > Variables and Secrets):
//   SERPER_KEY  - EASIEST: API key from serper.dev (Google results, free starter credits). Used first if present.
//   GOOGLE_KEY + GOOGLE_CX - alternative: Google Custom Search API key and Search engine ID
//   SETLISTFM_KEY - optional, for setlists and songs
// Endpoints:  /find?artist=&date=YYYY-MM-DD&hint=   /page?url=   /?artist=&date=dd-MM-yyyy (setlist.fm)
const H = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: H });
const dec = t => (t || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

export default {
  async fetch(req, env) {
    const u = new URL(req.url), q = u.searchParams;
    try {
      if (u.pathname === '/page') return J(await readPage(q.get('url'), q.get('artist') || '', q.get('date') || ''));
      if (u.pathname === '/find') return J(await find(env, q.get('artist') || '', q.get('date') || '', q.get('hint') || ''));
      return J(await setlist(env, q.get('artist'), q.get('date')));
    } catch (e) { return J({ error: String(e.message || e) }, 200); }
  }
};

async function setlist(env, artist, date) {
  if (!artist || !date || !env.SETLISTFM_KEY) return { setlist: [] };
  const r = await fetch(`https://api.setlist.fm/rest/1.0/search/setlists?artistName=${encodeURIComponent(artist)}&date=${date}`, { headers: { 'x-api-key': env.SETLISTFM_KEY, Accept: 'application/json' } });
  return r.status === 404 ? { setlist: [] } : r.json();
}

async function find(env, artist, date, hint) {
  const year = date.slice(0, 4);
  const nice = date ? new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
  const qWeb = `${artist} concert ${hint} ${nice} tickets announcement`;
  const qImg = `${artist} ${year} concert tour poster ${hint}`;
  let links = [], images = [];
  if (env.SERPER_KEY) {
    // Google results through serper.dev (simple API key, free starter credits)
    const post = (path, q) => fetch('https://google.serper.dev/' + path, { method: 'POST', headers: { 'X-API-KEY': env.SERPER_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ q, num: 8 }) }).then(r => r.json());
    const [w, i] = await Promise.all([post('search', qWeb), post('images', qImg)]);
    if (!w.organic && w.message) return { pages: [], images: [], error: 'Serper said: ' + w.message };
    links = (w.organic || []).map(x => x.link).slice(0, 5);
    images = (i.images || []).map(x => ({ url: x.imageUrl, thumb: x.thumbnailUrl, title: x.title }));
  } else if (env.GOOGLE_KEY && env.GOOGLE_CX) {
    const base = `https://www.googleapis.com/customsearch/v1?key=${env.GOOGLE_KEY}&cx=${env.GOOGLE_CX}`;
    const [w, i] = await Promise.all([
      fetch(`${base}&num=6&q=${encodeURIComponent(qWeb)}`).then(r => r.json()),
      fetch(`${base}&num=8&searchType=image&q=${encodeURIComponent(qImg)}`).then(r => r.json())
    ]);
    if (w.error) return { pages: [], images: [], error: 'Google said: ' + (w.error.message || 'error') };
    links = (w.items || []).map(x => x.link).slice(0, 5);
    images = (i.items || []).map(x => ({ url: x.link, thumb: x.image && x.image.thumbnailLink, title: x.title }));
  } else {
    return { pages: [], images: [], error: 'No search service is set up on the proxy yet (add SERPER_KEY, or GOOGLE_KEY and GOOGLE_CX).' };
  }
  const wanted = links.filter(l => !/wikipedia\.org|wikiwand|fandom\.com/i.test(l)); // Wikipedia is read separately by the site, with date checks
  const pages = (await Promise.allSettled(wanted.map(l => readPage(l, artist, date)))).filter(x => x.status === 'fulfilled' && !x.value.error).map(x => x.value);
  return { pages, images };
}

const MN = ['january','february','march','april','may','june','july','august','september','october','november','december'];
function dateForms(date) {
  const [y, m, d] = (date || '').split('-'); if (!y || !m || !d) return [];
  const full = MN[+m - 1], sh = full.slice(0, 3), dd = +d;
  return [date, `${full} ${dd}, ${y}`, `${full} ${dd} ${y}`, `${dd} ${full} ${y}`, `${sh} ${dd}, ${y}`, `${sh}. ${dd}, ${y}`, `${dd} ${sh} ${y}`, `${y}/${m}/${d}`, `${y}.${m}.${d}`, `${y}.${+m}.${dd}`, `${+m}/${dd}/${y}`, `${m}/${d}/${y}`];
}
const tokens = x => (x || '').toLowerCase().split(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7a3]+/).filter(Boolean);
const textOf = html => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').toLowerCase();
const flat = (x, out = []) => { if (Array.isArray(x)) x.forEach(i => flat(i, out)); else if (x && typeof x === 'object') { out.push(x); if (x['@graph']) flat(x['@graph'], out); } return out; };
const isEvent = o => [].concat(o['@type'] || []).some(t => /Event$|^Festival$/i.test(t));
const img1 = v => { v = Array.isArray(v) ? v[0] : v; return typeof v === 'string' ? v : (v && v.url) || ''; };
function place(l) {
  l = Array.isArray(l) ? l[0] : l; if (!l) return {};
  if (typeof l === 'string') return { venue: l };
  const a = typeof l.address === 'string' ? { addressLocality: l.address } : (l.address || {});
  const c = a.addressCountry; return { venue: l.name || '', city: a.addressLocality || '', country: (c && c.name) || (typeof c === 'string' ? c : '') };
}

async function readPage(url, artist = '', date = '') {
  if (!/^https?:\/\//i.test(url || '')) return { error: 'That does not look like a web link.' };
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 7000);
  let html = '';
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ConcertTracker/1.0)', 'Accept-Language': 'en' } });
    html = (await r.text()).slice(0, 1500000);
  } catch (e) { return { url, error: 'Could not open that page.' }; } finally { clearTimeout(t); }
  const meta = n => {
    const a = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + n + '["\'][^>]*content=["\']([^"\']*)["\']', 'i')) || html.match(new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:property|name)=["\']' + n + '["\']', 'i'));
    return a ? dec(a[1]) : '';
  };
  const tt = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const events = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      for (const ev of flat(JSON.parse(m[1])).filter(isEvent)) { const p = place(ev.location); events.push({ name: dec(ev.name), startDate: ev.startDate || '', venue: dec(p.venue), city: dec(p.city), country: dec(p.country), image: img1(ev.image) }); }
    } catch (e) {}
  }
  const matched = date ? events.find(e => (e.startDate || '').slice(0, 10) === date) : null;
  const event = matched || events[0] || null;
  const title = meta('og:title') || dec(tt && tt[1]), description = meta('og:description');
  const txt = textOf(html.slice(0, 600000)), head = (title + ' ' + description + ' ' + url + ' ' + (event ? event.name : '')).toLowerCase();
  const at = tokens(artist);
  const hasDate = date ? dateForms(date).some(f => txt.includes(f.toLowerCase())) : false;
  const artistInHead = at.length ? at.every(t => head.includes(t)) : false;
  const hasArtist = at.length ? at.every(t => txt.includes(t)) : false;
  return { url, title, image: meta('og:image'), description, event, eventCount: events.length, dateMatch: !!matched, hasDate, hasArtist, artistInHead };
}
