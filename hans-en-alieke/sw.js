// Elke kopie van de app (eigen map op hetzelfde domein) houdt een eigen cache bij
// en ruimt alleen zijn eigen oude caches op.
const PATH=new URL(self.registration.scope).pathname;
const V="v7";
const C="lijstjes|"+PATH+"|"+V;
const SHELL=["./","index.html","config.js","seed.js","recepten.js","recepten-lib.js","manifest.webmanifest","icon-192.png","icon-512.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>{
  if(k==="lijstjes-v1")return PATH==="/lijstjes/";
  const p=k.split("|");return p[0]==="lijstjes"&&p[1]===PATH&&k!==C;
}).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{
  const r=e.request;if(r.method!=="GET")return;
  const u=new URL(r.url);
  const lib=u.hostname==="www.gstatic.com"&&u.pathname.startsWith("/firebasejs/")||u.hostname.startsWith("fonts.");
  if(lib){e.respondWith(caches.open(C).then(c=>c.match(r).then(hit=>hit||fetch(r).then(res=>{c.put(r,res.clone());return res}))));return}
  // alleen bestanden van deze app zelf; submappen (andere kopieën) hebben hun eigen service worker
  if(u.origin!==location.origin||!u.pathname.startsWith(PATH)||u.pathname.slice(PATH.length).includes("/"))return;
  // altijd even bij de server navragen of er een nieuwere versie is (snel dankzij ETag)
  e.respondWith(fetch(r,{cache:"no-cache"}).then(res=>{const copy=res.clone();caches.open(C).then(c=>c.put(r,copy));return res}).catch(()=>caches.match(r).then(hit=>hit||caches.match(new URL("index.html",self.registration.scope).href))));
});
