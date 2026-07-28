// Pure DOM + formatting helpers for the admin dashboard. No app state — safe to
// import from both the shell (admin.js) and the renderers island. Extracted from
// admin.js verbatim.

export function qs(s){return document.querySelector(s)}
export function qsa(s){return document.querySelectorAll(s)}
export function el(tag,a,ch){
  var e=document.createElement(tag);
  if(a)Object.keys(a).forEach(function(k){if(k==='className')e.className=a[k];else if(k==='textContent')e.textContent=a[k];else e.setAttribute(k,a[k])});
  if(ch)ch.forEach(function(c){if(typeof c==='string')e.appendChild(document.createTextNode(c));else if(c)e.appendChild(c)});
  return e;
}
// Real HTML escaping, shared with the rest of the frontend. This used to be
// `String(s||'')` — a no-op wearing a security name — while feeding three
// `innerHTML` sinks in renderers.js. Keep calling it for anything interpolated
// into markup; use `el()`/textContent when you are only inserting text.
export { escapeHtml as esc } from '../escape-html.js';

// ── CSV parser (RFC 4180 compliant) ──

export function parseCSV(text){
  if(!text||!text.trim())return[];
  var rows=[],row=[],field='',inQ=false;
  for(var i=0;i<text.length;i++){
    var c=text[i];
    if(inQ){if(c==='"'&&text[i+1]==='"'){field+='"';i++}else if(c==='"'){inQ=false}else{field+=c}}
    else{if(c==='"'){inQ=true}else if(c===','){row.push(field);field=''}else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);field='';if(row.length>1||row[0]!=='')rows.push(row);row=[]}else{field+=c}}
  }
  row.push(field);if(row.length>1||row[0]!=='')rows.push(row);
  return rows;
}

export function fmtDate(iso){if(!iso)return'\u2014';try{return new Date(iso).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}catch(e){return iso}}
export function fmtDateTime(iso){if(!iso)return'\u2014';try{return new Date(iso).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}catch(e){return iso}}
export function daysAgo(n){var d=new Date();d.setDate(d.getDate()-n);d.setHours(0,0,0,0);return d}

export function badge(plan){var cls=plan==='pro'?'pro':plan==='enterprise'?'enterprise':'free';return el('span',{className:'adm-badge adm-badge-'+cls,textContent:plan})}
export function statusBadge(s){var c=s==='active'?'active':s==='trialing'?'trialing':'cancelled';return el('span',{className:'adm-badge adm-badge-'+c,textContent:s||'unknown'})}
export function authBadge(u){return el('span',{className:'adm-badge '+(u.googleSub?'adm-badge-google':'adm-badge-email'),textContent:u.googleSub?'Google':'Email'})}

// ── SVG icons ──

export var ICONS={
  users:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>',
  pro:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  gen:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  ent:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2L3 5v14a2 2 0 002 2h14a2 2 0 002-2V5l-3-3z"/><line x1="3" y1="5" x2="21" y2="5"/><path d="M16 10a4 4 0 01-8 0"/></svg>',
  dl:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  signup:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>',
  chart:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
  chat:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>',
  mask:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><line x1="2" y1="2" x2="9.586" y2="9.586"/><circle cx="11" cy="11" r="2"/></svg>'
};

export function iconDiv(name,colorClass){
  var d=el('div',{className:'adm-stat-icon '+colorClass});
  d.innerHTML=ICONS[name]||'';
  return d;
}

export function isStrictEmailClientProxyUa(ua){
  var s=String(ua||'').toLowerCase().trim();
  if(!s||s==='unknown')return false;
  var bots=['curl/','wget/','python-','go-http-client','bot','crawler','spider','scanner','preview','proofpoint','barracuda','mimecast','cloudflare'];
  for(var i=0;i<bots.length;i++){if(s.indexOf(bots[i])!==-1)return false}
  if(s.indexOf('googleimageproxy')!==-1||s.indexOf('ggpht.com')!==-1)return true;
  if(s.indexOf('yahoo! slurp')!==-1||s.indexOf('yahoomailproxy')!==-1)return true;
  if(s.indexOf('microsoft office')!==-1||s.indexOf('ms-office')!==-1||s.indexOf('outlook')!==-1)return true;
  return false;
}

export function fmtBytes(n){
  n=Number(n)||0;
  if(n<1024)return n+' B';
  if(n<1048576)return (n/1024).toFixed(1)+' KB';
  return (n/1048576).toFixed(1)+' MB';
}

export function fallbackCopy(text){
  try{
    var ta=document.createElement('textarea');
    ta.value=text;ta.style.position='fixed';ta.style.opacity='0';
    document.body.appendChild(ta);ta.focus();ta.select();
    document.execCommand('copy');document.body.removeChild(ta);
  }catch(e){}
}

export function copyToClipboard(text,btn){
  var done=function(){if(!btn)return;var o=btn.textContent;btn.textContent='Copied!';setTimeout(function(){btn.textContent=o},1200)};
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done).catch(function(){fallbackCopy(text);done()});
  }else{fallbackCopy(text);done()}
}

export function fullHostUrl(img){return location.origin+(img.path||('/i/'+img.id))}
