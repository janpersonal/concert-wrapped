// Cloudflare Worker: private search proxy for the concert tracker.
// Secrets to add (Settings > Variables and Secrets):
//   GOOGLE_KEY  - Google API key with "Custom Search API" enabled
//   GOOGLE_CX   - Programmable Search Engine ID (set it to search the entire web, with image search on)
//   SETLISTFM_KEY - optional, for setlists and songs
// Endpoints:  /find?artist=&date=YYYY-MM-DD&hint=   /page?url=   /?artist=&date=dd-MM-yyyy (setlist.fm)
const H = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: H });
const dec = t => (t || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

export default {
  async fetch(req, env) {
    const u = new URL(req.url), q = u.searchParams;
    try {
      if (u.pathname === '/page') return J(await readPage(q.get('url')));
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
  if (!env.GOOGLE_KEY || !env.GOOGLE_CX) return { pages: [], images: [], error: 'Google search is not set up on the proxy yet (GOOGLE_KEY and GOOGLE_CX).' };
  const year = date.slice(0, 4);
  const nice = date ? new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
  const base = `https://www.googleapis.com/customsearch/v1?key=${env.GOOGLE_KEY}&cx=${env.GOOGLE_CX}`;
  const web = fetch(`${base}&num=6&q=${encodeURIComponent(`${artist} concert ${hint} ${nice} tickets announcement`)}`).then(r => r.json());
  const img = fetch(`${base}&num=8&searchType=image&q=${encodeURIComponent(`${artist} ${year} concert tour poster ${hint}`)}`).then(r => r.json());
  const [w, i] = await Promise.all([web, img]);
  if (w.error) return { pages: [], images: [], error: 'Google said: ' + (w.error.message || 'error') };
  const links = (w.items || []).map(x => x.link).slice(0, 5);
  const pages = (await Promise.allSettled(links.map(l => readPage(l)))).filter(x => x.status === 'fulfilled' && !x.value.error).map(x => x.value);
  const images = (i.items || []).map(x => ({ url: x.link, thumb: x.image && x.image.thumbnailLink, title: x.title }));
  return { pages, images };
}

const flat = (x, out = []) => { if (Array.isArray(x)) x.forEach(i => flat(i, out)); else if (x && typeof x === 'object') { out.push(x); if (x['@graph']) flat(x['@graph'], out); } return out; };
const isEvent = o => [].concat(o['@type'] || []).some(t => /Event$|^Festival$/i.test(t));
const img1 = v => { v = Array.isArray(v) ? v[0] : v; return typeof v === 'string' ? v : (v && v.url) || ''; };
function place(l) {
  l = Array.isArray(l) ? l[0] : l; if (!l) return {};
  if (typeof l === 'string') return { venue: l };
  const a = typeof l.address === 'string' ? { addressLocality: l.address } : (l.address || {});
  const c = a.addressCountry; return { venue: l.name || '', city: a.addressLocality || '', country: (c && c.name) || (typeof c === 'string' ? c : '') };
}

async function readPage(url) {
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
  let event = null;
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const ev = flat(JSON.parse(m[1])).find(isEvent);
      if (ev) { const p = place(ev.location); event = { name: dec(ev.name), startDate: ev.startDate || '', venue: dec(p.venue), city: dec(p.city), country: dec(p.country), image: img1(ev.image) }; break; }
    } catch (e) {}
  }
  return { url, title: meta('og:title') || dec(tt && tt[1]), image: meta('og:image'), description: meta('og:description'), event };
}
