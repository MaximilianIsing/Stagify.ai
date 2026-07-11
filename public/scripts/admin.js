import { createRenderers } from './admin/renderers.js';
import { qs, qsa, el, parseCSV, copyToClipboard } from './admin/helpers.js';

(function () {
  'use strict';

  // ── Security: key stored in closure, cleared on sign-out ──
  var _key = '';
  var SESSION_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
  var _sessionStart = 0;
  var _loginAttempts = 0;
  var _lockoutUntil = 0;

  // Shared, mutable app state handed to the renderers island by reference so both
  // sides see the same data / filter / sort. signOut swaps ctx.data wholesale.
  var ctx = {
    data: { users:[], promptRows:[], chatRows:[], bugRows:[], maskRows:[], contactRows:[], emailOpenRows:[], enterprise:[], hostedImages:[] },
    userFilter: 'all',
    userSortCol: 'created',
    userSortDir: 'desc',
  };

  var renderers = createRenderers({ ctx: ctx, apiSend: apiSend, secureBlobDownload: secureBlobDownload });

  // ── Secure fetch: key sent in header, not URL ──

  // Header auth for the log/data endpoints so the key never appears in the URL
  // (no leak via logs/history/Referer).
  function apiFetchQ(url){
    checkSessionTimeout();
    return fetch(url,{headers:{'X-Stagify-Endpoint-Key':_key}})
      .then(function(r){if(!r.ok)throw new Error(String(r.status));return r});
  }

  // Mutating requests (POST/DELETE). For FormData bodies, the browser sets the
  // multipart Content-Type+boundary, so we must not set it ourselves.
  function apiSend(url,method,body,isForm){
    checkSessionTimeout();
    var opts={method:method,headers:{'X-Stagify-Endpoint-Key':_key}};
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

  function checkSessionTimeout(){
    if(_sessionStart && Date.now()-_sessionStart > SESSION_TIMEOUT_MS){
      signOut();
      alert('Session expired. Please sign in again.');
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
    }).catch(function(err){
      console.error('Load failed',err);
      if(String(err).indexOf('403')!==-1){signOut();return}
    });
  }

  function showLoading(){
    ['adm-stats','adm-recent-signups','adm-top-users','adm-users-table','adm-ent-table','adm-bugs-table','adm-contacts-table','adm-email-opens-table','adm-email-open-summary','adm-chart','adm-hosting-list'].forEach(function(id){
      var e=document.getElementById(id);if(e)e.innerHTML='<div class="adm-loading"><span class="adm-spinner"></span>Loading\u2026</div>';
    });
  }

  // ── Tabs ──

  qs('#adm-tabs').addEventListener('click',function(e){
    var btn=e.target.closest('.adm-tab');if(!btn)return;
    qsa('.adm-tab').forEach(function(t){t.classList.remove('active')});
    btn.classList.add('active');
    qsa('.adm-panel').forEach(function(p){p.classList.remove('active')});
    var p=qs('#panel-'+btn.dataset.tab);if(p)p.classList.add('active');
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

    fetch('/authstore',{headers:{'X-Stagify-Endpoint-Key':k}}).then(function(r){
      if(r.ok){
        _key=k;_sessionStart=Date.now();_loginAttempts=0;
        sessionStorage.setItem('adm_ts',String(_sessionStart));
        loadAll();
      } else {
        _loginAttempts++;
        if(_loginAttempts>=5){_lockoutUntil=Date.now()+30000;errEl.textContent='Too many failed attempts. Locked for 30 seconds.'}
        else{errEl.textContent='Invalid access key.'}
        errEl.classList.remove('hidden');
      }
    }).catch(function(){
      errEl.textContent='Network error. Please try again.';errEl.classList.remove('hidden');
    }).finally(function(){
      btn.disabled=false;btn.textContent='Sign in';
    });
  });

  // ── Sign out: wipe key from memory ──

  function signOut(){
    _key='';_sessionStart=0;
    sessionStorage.removeItem('adm_ts');
    ctx.data={users:[],promptRows:[],chatRows:[],bugRows:[],maskRows:[],contactRows:[],emailOpenRows:[],enterprise:[],hostedImages:[]};
    qs('#adm-dash').classList.add('hidden');
    qs('#adm-login').style.display='';
    qs('#adm-key').value='';
  }

  qs('#adm-signout').addEventListener('click',signOut);

  // ── No auto-login from sessionStorage (key is never persisted) ──
  // On page load the user must always re-enter the key.
  // sessionStorage only stores the timestamp for timeout tracking.


})();

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
