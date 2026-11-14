// Controlled aerodromes in Australia (those with a control tower), shared by the logbook page and the server.
// Two sources, either of which marks an aerodrome as controlled:
//  1. the published tower list below - civil towers from Airservices' Part 172 certificate (Jul 2025),
//     military towers from Defence;
//  2. OpenAIP: the aerodrome sits inside a control zone (CTR / military CTR).
// Each month the server compares the two across Australia and emails Aspex about any difference
// (see towerCheck in sites.js), so a new or closed tower is noticed. Tower hours vary: outside them an
// aerodrome may be non-controlled - always confirm against official Airservices data.
const Controlled = (() => {
  const LIST = Object.fromEntries([
    ...'YPAD Adelaide,YMAY Albury,YBAS Alice Springs,YBAF Archerfield,YMAV Avalon,YBNA Ballina,YSBK Bankstown,YBBN Brisbane,YBRM Broome,YBCS Cairns,YSCN Camden,YSCB Canberra,YCFS Coffs Harbour,YMEN Essendon,YBCG Gold Coast,YBHM Hamilton Island,YMHB Hobart,YPJT Jandakot,YPKA Karratha,YMLT Launceston,YBMK Mackay,YMML Melbourne,YMMB Moorabbin,YPPF Parafield,YPPH Perth,YBRK Rockhampton,YBSU Sunshine Coast,YSSY Sydney,YSTW Tamworth,YSWS Western Sydney'
      .split(',').map(x => [x.slice(0, 4), { name: x.slice(5), by: 'Airservices tower' }]),
    ...'YAMB Amberley,YPDN Darwin,YBTL Townsville,YWLM Williamtown,YSRI Richmond,YSNW Nowra,YMES East Sale,YPED Edinburgh,YPEA Pearce,YPTN Tindal,YBOK Oakey,YPLM Learmonth,YBSG Scherger,YCIN Curtin'
      .split(',').map(x => [x.slice(0, 4), { name: x.slice(5), by: 'military tower' }]),
  ]);
  const CTR_TYPES = new Set([4, 36]);                 // OpenAIP: CTR, military CTR
  const isCtr = (a) => CTR_TYPES.has(Number(a.type));
  // Is this aerodrome controlled? -> { by: 'Airservices tower' | 'military tower' | 'inside <name> control zone' } or null.
  // airport: { icao, coords:[lon,lat] }; airspaces: [{ type, name, geometry }] (OpenAIP)
  function check(airport, airspaces, Geo) {
    const hit = LIST[String(airport.icao || '').toUpperCase()];
    if (hit) return { by: hit.by };
    if (airport.coords) for (const a of airspaces || []) {
      if (!isCtr(a) || !a.geometry) continue;
      const polys = Geo.fromGeoJSON(a.geometry);
      if (polys.length && Geo.inPolys(airport.coords, polys)) return { by: `OpenAIP shows it inside a control zone${a.name ? ", " + a.name : ""}` };
    }
    return null;
  }
  return { LIST, isCtr, check };
})();
if (typeof module !== 'undefined') module.exports = Controlled;
