import { createRenderers } from './admin/renderers.js';
import { createEmailsPanel } from './admin/emails.js';
import { createReferralsPanel } from './admin/referrals.js';
import { createStatusPanel } from './admin/status-panel.js';
import { qs, qsa, el, parseCSV, copyToClipboard } from './admin/helpers.js';
import { showErrorToast } from './toast.js';

(function () {
  'use strict';

  // ── Security: the master key is never persisted, and barely even held ──
  //
  // Signing in EXCHANGES endpoint_key for a scoped session token
  // (POST /api/admin/session — see lib/data/admin-sessions.js). The key exists only
  // as a local inside that one request and is never stored anywhere, not even in
  // this closure; the token is what persists across reloads, and it is strictly
  // weaker: dashboard routes only, 30 days, revocable server-side.
  //
  // localStorage rather than sessionStorage on purpose — sessionStorage is per-tab
  // and dies with the tab, which is the exact annoyance this replaces.
  var _session = '';
  var _sessionExp = 0;
  var SESSION_KEY = 'adm_session';
  var SESSION_EXP_KEY = 'adm_session_exp';
  var _loginAttempts = 0;
  var _lockoutUntil = 0;

  // Storage can throw (Safari private mode, disabled cookies/storage). It failing is
  // not a reason to break the console — it just means this browser re-authenticates
  // on every load, which is where we started.
  function lsGet(k){try{return localStorage.getItem(k)}catch(e){return null}}
  function lsSet(k,v){try{localStorage.setItem(k,v)}catch(e){/* memory-only session */}}
  function lsDel(k){try{localStorage.removeItem(k)}catch(e){/* nothing to clear */}}

  // Whichever credential we hold. After sign-in this is always the token: the key
  // is deliberately not kept, so there is nothing here that could leak it.
  function authHeaders(){
    return _session ? {'X-Stagify-Admin-Session':_session} : {};
  }

  // Shared, mutable app state handed to the renderers island by reference so both
  // sides see the same data / filter / sort. signOut swaps ctx.data wholesale.
  var ctx = {
    data: { users:[], promptRows:[], chatRows:[], bugRows:[], maskRows:[], contactRows:[], emailOpenRows:[], enterprise:[], hostedImages:[] },
    userFilter: 'all',
    userSortCol: 'created',
    userSortDir: 'desc',
  };

  var renderers = createRenderers({ ctx: ctx, apiSend: apiSend, secureBlobDownload: secureBlobDownload });
  var emailsPanel = createEmailsPanel({ apiSend: apiSend });
  emailsPanel.init();
  var referralsPanel = createReferralsPanel({ apiSend: apiSend });
  referralsPanel.init();
  var statusPanel = createStatusPanel({ apiSend: apiSend });
  statusPanel.init();

  // ── Secure fetch: credential sent in a header, never the URL ──

  // Header auth for the log/data endpoints so the credential never appears in the
  // URL (no leak via logs/history/Referer). Header-only is also what keeps the admin
  // routes CSRF-proof by construction: nothing a browser sends automatically can
  // reach them, which is precisely why this is a token in storage and not a cookie.
  function apiFetchQ(url){
    checkSessionExpiry();
    return fetch(url,{headers:authHeaders()})
      .then(function(r){if(!r.ok)throw new Error(String(r.status));return r});
  }

  // Mutating requests (POST/DELETE). For FormData bodies, the browser sets the
  // multipart Content-Type+boundary, so we must not set it ourselves.
  function apiSend(url,method,body,isForm){
    checkSessionExpiry();
    var opts={method:method,headers:authHeaders()};
    if(body!==undefined&&body!==null){
      if(isForm){opts.body=body}
      else{opts.headers['Content-Type']='application/json';opts.body=JSON.stringify(body)}
    }
    return fetch(url,opts).then(function(r){
      if(!r.ok){
        return r.json().catch(function(){return{}}).then(function(j){throw new Error(j.error||('HTTP '+r.status))});
      }
      return r.json().catch(function(){return{}});
    });
  }

  // The server is the authority on expiry (and slides it on use); this is the local
  // half, so a session that lapsed while the tab sat open lands on the login screen
  // instead of firing a burst of 403s. There is deliberately no idle timeout on top:
  // a 30-day session that logged you out after an hour of the tab being open would
  // reintroduce the very thing it exists to remove.
  function checkSessionExpiry(){
    if(_sessionExp && Date.now() > _sessionExp){
      signOut();
      // signOut() re-shows the login form in place — it does not navigate or
      // reload — so the non-blocking toast outlives it and stays readable. Nothing
      // here depended on alert() halting the caller: _sessionExp is cleared above,
      // so the sibling requests in a single loadAll() burst re-enter this and no-op.
      showErrorToast('Session expired. Please sign in again.');
    }
  }

  // ── Secure blob download (key never in URL bar or history) ──

  function secureBlobDownload(url, filename){
    return apiFetchQ(url).then(function(r){return r.blob()}).then(function(blob){
      var a=document.createElement('a');
      var objUrl=URL.createObjectURL(blob);
      a.href=objUrl;a.download=filename;
      document.body.appendChild(a);a.click();
      setTimeout(function(){document.body.removeChild(a);URL.revokeObjectURL(objUrl)},200);
    });
  }

  // ── Load all data ──

  function loadAll(){
    qs('#adm-dash').classList.remove('hidden');
    qs('#adm-login').style.display='none';
    showLoading();

    Promise.all([
      apiFetchQ('/authstore').then(function(r){return r.json()}),
      apiFetchQ('/promptlogs').then(function(r){return r.text()}).catch(function(){return''}),
      apiFetchQ('/chatlogs').then(function(r){return r.text()}).catch(function(){return''}),
      apiFetchQ('/bugreports').then(function(r){return r.text()}).catch(function(){return''}),
      apiFetchQ('/masklogs').then(function(r){return r.text()}).catch(function(){return''}),
      apiFetchQ('/contactlogs').then(function(r){return r.text()}).catch(function(){return''}),
      apiFetchQ('/email-open-logs').then(function(r){return r.text()}).catch(function(){return''}),
      apiFetchQ('/enterprise-domains').then(function(r){return r.json()}).catch(function(){return{domains:[]}}),
      apiFetchQ('/api/hosted-images').then(function(r){return r.json()}).catch(function(){return{images:[]}})
    ]).then(function(res){
      ctx.data.users=(res[0]&&res[0].users)||[];
      ctx.data.promptRows=parseCSV(res[1]);
      ctx.data.chatRows=parseCSV(res[2]);
      ctx.data.bugRows=parseCSV(res[3]);
      ctx.data.maskRows=parseCSV(res[4]);
      ctx.data.contactRows=parseCSV(res[5]);
      ctx.data.emailOpenRows=parseCSV(res[6]);
      ctx.data.enterprise=(res[7]&&res[7].domains)||[];
      ctx.data.hostedImages=(res[8]&&res[8].images)||[];
      renderers.updateTabCounts();
      renderers.renderAll();
      qs('#adm-last-refresh').textContent='Updated '+new Date().toLocaleTimeString();
      // Referrals load lazily on tab open, so Refresh has to invalidate them
      // explicitly — and refetch immediately if that is the tab being looked at.
      referralsPanel.reset();
      var refPanel=qs('#panel-referrals');
      if(refPanel&&refPanel.classList.contains('active'))referralsPanel.ensureLoaded();
      var statusPanelEl=qs('#panel-status');
      if(statusPanelEl&&statusPanelEl.classList.contains('active'))statusPanel.ensureLoaded();
    }).catch(function(err){
      console.error('Load failed',err);
      if(String(err).indexOf('403')!==-1){signOut();return}
    });
  }

  function showLoading(){
    ['adm-stats','adm-recent-signups','adm-top-users','adm-users-table','adm-ent-table','adm-bugs-table','adm-contacts-table','adm-email-opens-table','adm-email-open-summary','adm-charts','adm-insights','adm-hosting-list'].forEach(function(id){
      var e=document.getElementById(id);if(e)e.innerHTML='<div class="adm-loading"><span class="adm-spinner"></span>Loading\u2026</div>';
    });
  }

  // ── Tabs ──

  // Mirror the active rail item into the sticky topbar. Tolerates a button with
  // no data-* (the DOM-stubbed suite builds bare ones) by falling back to its text.
  function setPageHeading(btn){
    var t=qs('#adm-page-title');
    var sub=qs('#adm-page-sub');
    var title=(btn.dataset&&btn.dataset.title)||btn.textContent||'';
    if(t)t.textContent=title.trim();
    if(sub)sub.textContent=(btn.dataset&&btn.dataset.sub)||'';
  }

  qs('#adm-tabs').addEventListener('click',function(e){
    var btn=e.target.closest('.adm-tab');if(!btn)return;
    qsa('.adm-tab').forEach(function(t){t.classList.remove('active');t.setAttribute('aria-selected','false')});
    btn.classList.add('active');btn.setAttribute('aria-selected','true');
    qsa('.adm-panel').forEach(function(p){p.classList.remove('active')});
    var p=qs('#panel-'+btn.dataset.tab);if(p)p.classList.add('active');
    // The rail is the only place a section is named, so the topbar has to follow
    // it — otherwise every panel is titled "Overview". The labels live on the
    // button (data-title/data-sub) so markup stays the single source of truth.
    setPageHeading(btn);
    // The Emails gallery and the Referrals panel aren't part of the loadAll() burst
    // — lazy-load each the first time its tab opens.
    if(btn.dataset.tab==='emails')emailsPanel.ensureLoaded();
    if(btn.dataset.tab==='referrals')referralsPanel.ensureLoaded();
    // Status is live data, so opening the tab always refetches rather than showing
    // whatever was true when it was last looked at.
    if(btn.dataset.tab==='status')statusPanel.ensureLoaded();
    // Panels are display:none while inactive, so a tab that was hidden during the
    // last render starts scrolled wherever the previous one was.
    //
    // Both, deliberately: the scrollport on this page is <body>, not the viewport
    // — styles.css sets html{overflow-x:clip}, and a non-visible overflow on <html>
    // stops <body>'s own overflow-y propagating up to the viewport. So
    // window.scrollTo silently does nothing here, and did before this was noticed.
    window.scrollTo({top:0,behavior:'smooth'});
    // Instant for the body, not smooth: Chrome ignores behavior:'smooth' when
    // <body> is the scroller (scrollTo(0,0) and .scrollTop both work), so asking
    // for smooth here is a second silent no-op on top of the first.
    if(document.body&&document.body.scrollTo)document.body.scrollTo(0,0);
  });

  // ── User filters ──

  qsa('.adm-filter').forEach(function(btn){
    btn.addEventListener('click',function(){
      ctx.userFilter=btn.dataset.filter;
      qsa('.adm-filter').forEach(function(b){b.classList.toggle('active',b.dataset.filter===ctx.userFilter)});
      renderers.renderUsers();
    });
  });
  qs('#adm-filter-all').classList.add('active');

  // ── Search ──

  qs('#adm-user-search').addEventListener('input',function(){renderers.renderUsers(this.value)});
  qs('#adm-bug-search').addEventListener('input',function(){renderers.renderBugs(this.value)});
  qs('#adm-contact-search').addEventListener('input',function(){renderers.renderContacts(this.value)});
  qs('#adm-email-open-search').addEventListener('input',function(){renderers.renderEmailOpens(this.value)});

  // ── Image hosting: upload wiring ──

  var _hostFile=null;
  qs('#adm-host-pick').addEventListener('click',function(){qs('#adm-host-file').click()});
  qs('#adm-host-file').addEventListener('change',function(){
    _hostFile=(this.files&&this.files[0])||null;
    qs('#adm-host-fname').textContent=_hostFile?_hostFile.name:'No file selected';
    qs('#adm-host-upload-btn').disabled=!_hostFile;
    qs('#adm-host-result').classList.add('hidden');
  });
  qs('#adm-host-upload-btn').addEventListener('click',function(){
    if(!_hostFile)return;
    var btn=this;btn.disabled=true;btn.textContent='Uploading…';
    var resBox=qs('#adm-host-result');resBox.classList.add('hidden');resBox.classList.remove('adm-host-err');
    var fd=new FormData();fd.append('image',_hostFile);
    apiSend('/api/host-image','POST',fd,true).then(function(j){
      var url=location.origin+(j.path||('/i/'+j.id));
      resBox.classList.remove('hidden','adm-host-err');resBox.innerHTML='';
      resBox.appendChild(el('div',{style:'font-weight:700;color:#166534;margin-bottom:.5rem',textContent:'✓ Image hosted — here is your public link:'}));
      var row=el('div',{className:'adm-host-url-row'});
      row.appendChild(el('div',{className:'adm-host-url',title:url,textContent:url}));
      var cp=el('button',{className:'adm-host-copy',type:'button',textContent:'Copy'});
      cp.addEventListener('click',function(){copyToClipboard(url,cp)});
      row.appendChild(cp);
      resBox.appendChild(row);
      _hostFile=null;qs('#adm-host-file').value='';qs('#adm-host-fname').textContent='No file selected';
      btn.textContent='Upload & Host';btn.disabled=true;
      if(j.entry){ctx.data.hostedImages.unshift(Object.assign({},j.entry,{path:j.path||('/i/'+j.id)}))}
      renderers.updateTabCounts();renderers.renderHosting();
    }).catch(function(e){
      resBox.classList.remove('hidden');resBox.classList.add('adm-host-err');
      resBox.textContent='Upload failed: '+e.message;
      btn.disabled=false;btn.textContent='Upload & Host';
    });
  });

  // ── Refresh ──

  qs('#adm-refresh').addEventListener('click',function(){
    var btn=qs('#adm-refresh');btn.disabled=true;btn.textContent='Refreshing\u2026';
    loadAll();
    setTimeout(function(){btn.disabled=false;btn.textContent='Refresh'},1500);
  });

  // \u2500\u2500 Reset server status (uptime) data \u2500\u2500

  (function(){
    var rb=qs('#adm-reset-status');if(!rb)return;
    rb.addEventListener('click',function(){
      if(!confirm('Reset ALL server status data?\n\nThis wipes every recorded uptime percentage and incident and restarts monitoring from now. It changes the public status page and cannot be undone.'))return;
      var msg=qs('#adm-reset-status-msg');var orig=rb.textContent;
      rb.disabled=true;rb.textContent='Resetting\u2026';if(msg)msg.textContent='';
      apiSend('/api/status/reset','POST').then(function(){
        rb.disabled=false;rb.textContent=orig;
        if(msg){msg.style.color='#166534';msg.textContent='\u2713 Server status reset. Monitoring restarted from now.'}
      }).catch(function(e){
        rb.disabled=false;rb.textContent=orig;
        if(msg){msg.style.color='#dc2626';msg.textContent='Reset failed: '+e.message}
      });
    });
  })();

  // ── Login with rate limiting ──

  qs('#adm-login-form').addEventListener('submit',function(e){
    e.preventDefault();
    var k=qs('#adm-key').value.trim();if(!k)return;
    var errEl=qs('#adm-login-err');
    var btn=qs('#adm-login-btn');

    if(Date.now()<_lockoutUntil){
      var secs=Math.ceil((_lockoutUntil-Date.now())/1000);
      errEl.textContent='Too many attempts. Try again in '+secs+'s.';
      errEl.classList.remove('hidden');
      return;
    }

    errEl.classList.add('hidden');
    btn.disabled=true;btn.textContent='Verifying\u2026';

    // The mint IS the key check — it is behind the key-only guard and 403s on a bad
    // key — so there is no separate probe, and no data endpoint is touched to find
    // out whether the key is right. `k` is a local: it goes out of scope when this
    // handler returns and is never assigned to anything that outlives it.
    fetch('/api/admin/session',{method:'POST',headers:{'X-Stagify-Endpoint-Key':k}}).then(function(r){
      if(r.ok){
        return r.json().then(function(j){
          _loginAttempts=0;
          adoptSession(j.token,j.expiresAt);
          loadAll();
        });
      }
      _loginAttempts++;
      if(_loginAttempts>=5){_lockoutUntil=Date.now()+30000;errEl.textContent='Too many failed attempts. Locked for 30 seconds.'}
      else{errEl.textContent='Invalid access key.'}
      errEl.classList.remove('hidden');
      return null;
    }).catch(function(){
      errEl.textContent='Network error. Please try again.';errEl.classList.remove('hidden');
    }).finally(function(){
      btn.disabled=false;btn.textContent='Sign in';
    });
  });

  // Hold a freshly minted session, in memory and in storage. Storage failing is
  // survivable — the tab stays signed in, it just won't outlive a reload.
  function adoptSession(token,expiresAt){
    _session=String(token||'');
    _sessionExp=Number(expiresAt)||0;
    if(!_session)return;
    lsSet(SESSION_KEY,_session);
    lsSet(SESSION_EXP_KEY,String(_sessionExp));
  }

  function clearStoredSession(){
    _session='';_sessionExp=0;
    lsDel(SESSION_KEY);lsDel(SESSION_EXP_KEY);
  }

  // ── Sign out: revoke server-side, then wipe locally ──

  function signOut(){
    // Fire-and-forget REVOKE, before the local wipe takes the credential away.
    // Clearing storage alone would leave a live token on the server that anything
    // holding a copy could keep using — "sign out" has to mean it.
    if(_session){
      try{
        fetch('/api/admin/session',{method:'DELETE',headers:authHeaders()}).catch(function(){});
      }catch(e){/* offline: the token still expires on its own */}
    }
    clearStoredSession();
    emailsPanel.reset();
    referralsPanel.reset();
    statusPanel.reset();
    ctx.data={users:[],promptRows:[],chatRows:[],bugRows:[],maskRows:[],contactRows:[],emailOpenRows:[],enterprise:[],hostedImages:[]};
    qs('#adm-dash').classList.add('hidden');
    qs('#adm-login').style.display='';
    qs('#adm-key').value='';
  }

  qs('#adm-signout').addEventListener('click',signOut);

  // ── Resume a stored session ──
  //
  // The KEY is still never persisted and never auto-filled; what is restored is the
  // scoped token. It is verified against /api/admin/ping BEFORE the dashboard is
  // revealed, so a token that was revoked, expired, or outlived a key rotation lands
  // on the login screen instead of flashing a dashboard that then 403s nine times.
  (function restoreSession(){
    var token=lsGet(SESSION_KEY);
    if(!token)return;
    var exp=Number(lsGet(SESSION_EXP_KEY))||0;
    if(exp&&Date.now()>exp){clearStoredSession();return}

    _session=token;_sessionExp=exp;
    fetch('/api/admin/ping',{headers:authHeaders()}).then(function(r){
      if(r.ok)return loadAll();
      // Rejected: the token is dead for good, so drop it rather than leaving a
      // credential in storage that can only ever produce 403s.
      clearStoredSession();
      return null;
    }).catch(function(){
      // Offline or the server is down. Keep the token — it is probably still valid —
      // and leave the login screen up; the next load will try again.
      _session='';
    });
  })();


})();

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
