const C="lijstjes-v1";
const SHELL=["./","index.html","config.js","seed.js","manifest.webmanifest","icon-192.png","icon-512.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{
  const r=e.request;if(r.method!=="GET")return;
  const u=new URL(r.url);
  const lib=u.hostname==="www.gstatic.com"&&u.pathname.startsWith("/firebasejs/")||u.hostname.startsWith("fonts.");
  if(lib){e.respondWith(caches.open(C).then(c=>c.match(r).then(hit=>hit||fetch(r).then(res=>{c.put(r,res.clone());return res}))));return}
  if(u.origin!==location.origin)return;
  e.respondWith(fetch(r).then(res=>{const copy=res.clone();caches.open(C).then(c=>c.put(r,copy));return res}).catch(()=>caches.match(r).then(hit=>hit||caches.match("index.html"))));
});
