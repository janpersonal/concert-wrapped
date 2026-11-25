// Cloudflare Worker: tiny proxy so your setlist.fm API key stays private.
// Setup: Workers & Pages > Create > paste this code > Settings > Variables > add secret SETLISTFM_KEY.
export default {
  async fetch(request, env) {
    const cors = { 'Access-Control-Allow-Origin': '*' }; // tighten to your site's URL once it works
    const u = new URL(request.url);
    const artist = u.searchParams.get('artist');
    const date = u.searchParams.get('date'); // dd-MM-yyyy
    if (!artist || !date) return new Response('{"setlist":[]}', { headers: { ...cors, 'Content-Type': 'application/json' } });
    const api = `https://api.setlist.fm/rest/1.0/search/setlists?artistName=${encodeURIComponent(artist)}&date=${date}`;
    const r = await fetch(api, { headers: { 'x-api-key': env.SETLISTFM_KEY, Accept: 'application/json' } });
    return new Response(r.status === 404 ? '{"setlist":[]}' : await r.text(), { headers: { ...cors, 'Content-Type': 'application/json' } });
  }
};
