(function () {
  'use strict';

  // ── Security: key stored in closure, cleared on sign-out ──
  var _key = '';
  var SESSION_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
  var _sessionStart = 0;
  var _loginAttempts = 0;
  var _lockoutUntil = 0;
  var data = { users:[], promptRows:[], chatRows:[], bugRows:[], maskRows:[], contactRows:[], emailOpenRows:[], enterprise:[], hostedImages:[] };
  var userFilter = 'all';
  var userSortCol = 'created';
  var userSortDir = 'desc';

  function qs(s){return document.querySelector(s)}
  function qsa(s){return document.querySelectorAll(s)}
  function el(tag,a,ch){
    var e=document.createElement(tag);
    if(a)Object.keys(a).forEach(function(k){if(k==='className')e.className=a[k];else if(k==='textContent')e.textContent=a[k];else e.setAttribute(k,a[k])});
    if(ch)ch.forEach(function(c){if(typeof c==='string')e.appendChild(document.createTextNode(c));else if(c)e.appendChild(c)});
    return e;
  }
  function esc(s){return String(s||'')} // textContent is already safe, this is for clarity

  // ── CSV parser (RFC 4180 compliant) ──

  function parseCSV(text){
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

  function fmtDate(iso){if(!iso)return'\u2014';try{return new Date(iso).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}catch(e){return iso}}
  function fmtDateTime(iso){if(!iso)return'\u2014';try{return new Date(iso).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}catch(e){return iso}}
  function daysAgo(n){var d=new Date();d.setDate(d.getDate()-n);d.setHours(0,0,0,0);return d}
  function dayKey(iso){try{return new Date(iso).toISOString().slice(0,10)}catch(e){return null}}

  function badge(plan){var cls=plan==='pro'?'pro':plan==='enterprise'?'enterprise':'free';return el('span',{className:'adm-badge adm-badge-'+cls,textContent:plan})}
  // True if the user gets Stagify+ via an active enterprise domain (not their own sub).
  function userEnterpriseActive(u){
    var dom=(u&&u.email||'').split('@')[1];
    if(!dom)return false;
    dom=dom.toLowerCase();
    return data.enterprise.some(function(e){
      return e.domain&&e.domain.toLowerCase()===dom&&(e.status==='active'||e.status==='trialing');
    });
  }
  // Plan shown in the admin UI: own Pro subscription wins; otherwise enterprise; else stored plan.
  function effectivePlan(u){
    if(!u)return'free';
    if(u.plan==='pro')return'pro';
    if(userEnterpriseActive(u))return'enterprise';
    return u.plan||'free';
  }
  function statusBadge(s){var c=s==='active'?'active':s==='trialing'?'trialing':'cancelled';return el('span',{className:'adm-badge adm-badge-'+c,textContent:s||'unknown'})}
  function authBadge(u){return el('span',{className:'adm-badge '+(u.googleSub?'adm-badge-google':'adm-badge-email'),textContent:u.googleSub?'Google':'Email'})}

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
      data.users=(res[0]&&res[0].users)||[];
      data.promptRows=parseCSV(res[1]);
      data.chatRows=parseCSV(res[2]);
      data.bugRows=parseCSV(res[3]);
      data.maskRows=parseCSV(res[4]);
      data.contactRows=parseCSV(res[5]);
      data.emailOpenRows=parseCSV(res[6]);
      data.enterprise=(res[7]&&res[7].domains)||[];
      data.hostedImages=(res[8]&&res[8].images)||[];
      updateTabCounts();
      renderAll();
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

  function updateTabCounts(){
    qs('#tc-users').textContent=data.users.length;
    qs('#tc-ent').textContent=data.enterprise.length;
    qs('#tc-bugs').textContent=data.bugRows.length;
    qs('#tc-contacts').textContent=data.contactRows.length;
    qs('#tc-email-opens').textContent=getOpenedEmails().length;
    qs('#tc-hosting').textContent=data.hostedImages.length;
  }

  // ── Prompt index ──

  function buildPromptIndex(){
    var idx={};
    data.promptRows.forEach(function(r){
      var email=(r[7]||'').trim().toLowerCase();
      if(!email||email==='unknown')return;
      if(!idx[email])idx[email]=[];
      idx[email].push(r);
    });
    return idx;
  }

  // ── SVG icons ──

  var ICONS={
    users:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>',
    pro:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    gen:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
    ent:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2L3 5v14a2 2 0 002 2h14a2 2 0 002-2V5l-3-3z"/><line x1="3" y1="5" x2="21" y2="5"/><path d="M16 10a4 4 0 01-8 0"/></svg>',
    dl:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    signup:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>',
    chart:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>'
  };

  function iconDiv(name,colorClass){
    var d=el('div',{className:'adm-stat-icon '+colorClass});
    d.innerHTML=ICONS[name]||'';
    return d;
  }

  // ── Render all ──

  function renderAll(){
    [renderOverview,renderUsers,renderEnterprise,renderContacts,renderEmailOpens,renderBugs,renderHosting,renderDownloads].forEach(function(fn){
      try{fn()}catch(e){console.error('Admin render error in '+fn.name+':',e)}
    });
  }

  function renderOverview(){
    var pIdx=buildPromptIndex();
    var total=data.promptRows.length;
    var d7=daysAgo(7),d30=daysAgo(30);
    var g7=0,g30=0;
    data.promptRows.forEach(function(r){try{var t=new Date(r[0]);if(t>=d7)g7++;if(t>=d30)g30++}catch(e){}});
    var pro=data.users.filter(function(u){return u.plan==='pro'}).length;
    var free=data.users.filter(function(u){return u.plan==='free'}).length;
    var s30=0;
    data.users.forEach(function(u){try{var t=new Date(u.createdAt);if(t>=d30)s30++}catch(e){}});
    var activeEnt=data.enterprise.filter(function(e){return e.status==='active'||e.status==='trialing'}).length;

    var stats=[
      {val:data.users.length,lbl:'Total Users',icon:'users',color:'adm-stat-icon--blue'},
      {val:pro,lbl:'Pro Subscribers',icon:'pro',color:'adm-stat-icon--purple'},
      {val:free,lbl:'Free Users',icon:'users',color:'adm-stat-icon--blue'},
      {val:activeEnt,lbl:'Enterprise Domains',icon:'ent',color:'adm-stat-icon--amber'},
      {val:total.toLocaleString(),lbl:'Total Generations',icon:'gen',color:'adm-stat-icon--green'},
      {val:g30.toLocaleString(),lbl:'Generations (30d)',icon:'gen',color:'adm-stat-icon--green'},
      {val:g7.toLocaleString(),lbl:'Generations (7d)',icon:'chart',color:'adm-stat-icon--green'},
      {val:s30,lbl:'Signups (30d)',icon:'signup',color:'adm-stat-icon--purple'},
    ];
    var sc=qs('#adm-stats');sc.innerHTML='';
    stats.forEach(function(s){
      sc.appendChild(el('div',{className:'adm-stat'},[
        iconDiv(s.icon,s.color),
        el('div',{className:'adm-stat-body'},[
          el('span',{className:'adm-stat-val',textContent:String(s.val)}),
          el('span',{className:'adm-stat-lbl',textContent:s.lbl})
        ])
      ]));
    });

    // top users
    var topArr=[];
    Object.keys(pIdx).forEach(function(em){
      var cnt=pIdx[em].filter(function(r){try{return new Date(r[0])>=d30}catch(e){return false}}).length;
      if(cnt>0)topArr.push({email:em,cnt:cnt,total:pIdx[em].length});
    });
    topArr.sort(function(a,b){return b.cnt-a.cnt});

    var tw=qs('#adm-top-users');tw.innerHTML='';
    if(!topArr.length){tw.innerHTML='<p style="color:#94a3b8;font-size:.85rem;padding:.5rem">No generation data yet.</p>';return}
    var ttbl=el('table',{className:'adm-table'});
    ttbl.appendChild(el('thead',null,[el('tr',null,[el('th',{textContent:'Email'}),el('th',{textContent:'30d'}),el('th',{textContent:'All'})])]));
    var ttb=el('tbody');
    topArr.slice(0,10).forEach(function(u){
      ttb.appendChild(el('tr',null,[el('td',{textContent:u.email}),el('td',{textContent:String(u.cnt)}),el('td',{textContent:String(u.total)})]));
    });
    ttbl.appendChild(ttb);tw.appendChild(ttbl);

    // recent signups
    var recent=data.users.slice().filter(function(u){try{return new Date(u.createdAt)>=d30}catch(e){return false}})
      .sort(function(a,b){return new Date(b.createdAt).getTime()-new Date(a.createdAt).getTime()});
    var rw=qs('#adm-recent-signups');rw.innerHTML='';
    if(!recent.length){rw.innerHTML='<p style="color:#94a3b8;font-size:.85rem;padding:.5rem">No signups in last 30 days.</p>';return}
    var rtbl=el('table',{className:'adm-table'});
    rtbl.appendChild(el('thead',null,[el('tr',null,[el('th',{textContent:'Email'}),el('th',{textContent:'Plan'}),el('th',{textContent:'Date'})])]));
    var rtb=el('tbody');
    recent.slice(0,15).forEach(function(u){
      rtb.appendChild(el('tr',null,[el('td',{textContent:u.email}),el('td',null,[badge(effectivePlan(u))]),el('td',{textContent:fmtDate(u.createdAt)})]));
    });
    rtbl.appendChild(rtb);rw.appendChild(rtbl);

    // daily chart (simple bar chart via divs)
    renderDailyChart(d30);
  }

  function renderDailyChart(_since){
    var buckets={};
    for(var i=0;i<30;i++){var dk=daysAgo(i).toISOString().slice(0,10);buckets[dk]=0}
    data.promptRows.forEach(function(r){var k=dayKey(r[0]);if(k&&buckets[k]!==undefined)buckets[k]++});
    var keys=Object.keys(buckets).sort();
    var max=Math.max.apply(null,keys.map(function(k){return buckets[k]}))||1;

    var wrap=qs('#adm-chart');wrap.innerHTML='';
    var chart=el('div',{style:'display:flex;align-items:flex-end;gap:3px;height:120px;padding:0 .25rem'});
    keys.forEach(function(k){
      var v=buckets[k];
      var pct=Math.max(2,Math.round(v/max*100));
      var bar=el('div',{
        style:'flex:1;min-width:8px;height:'+pct+'%;background:#3b82f6;border-radius:3px 3px 0 0;transition:height .3s;position:relative;cursor:default',
        title:k+': '+v+' generations'
      });
      chart.appendChild(bar);
    });
    wrap.appendChild(chart);
    var labels=el('div',{style:'display:flex;justify-content:space-between;font-size:.65rem;color:#94a3b8;padding:4px .25rem 0'});
    labels.appendChild(el('span',{textContent:keys[0]}));
    labels.appendChild(el('span',{textContent:keys[keys.length-1]}));
    wrap.appendChild(labels);
  }

  // ── Users ──

  function userGens30(u, pIdx, d30){
    var allR=pIdx[(u.email||'').toLowerCase()]||[];
    return allR.filter(function(r){try{return new Date(r[0])>=d30}catch(e){return false}}).length;
  }

  function userGensAll(u, pIdx){
    return (pIdx[(u.email||'').toLowerCase()]||[]).length;
  }

  function sortUserList(list, pIdx, d30){
    var dir=userSortDir==='asc'?1:-1;
    return list.sort(function(a,b){
      var av,bv;
      switch(userSortCol){
        case 'email':
          av=(a.email||'').toLowerCase(); bv=(b.email||'').toLowerCase();
          return av.localeCompare(bv)*dir;
        case 'plan':
          av=effectivePlan(a); bv=effectivePlan(b);
          return av.localeCompare(bv)*dir;
        case 'auth':
          av=a.googleSub?'google':'email'; bv=b.googleSub?'google':'email';
          return av.localeCompare(bv)*dir;
        case 'created':
          av=new Date(a.createdAt||0).getTime(); bv=new Date(b.createdAt||0).getTime();
          return (av-bv)*dir;
        case 'gens30':
          av=userGens30(a,pIdx,d30); bv=userGens30(b,pIdx,d30);
          return (av-bv)*dir;
        case 'gensAll':
          av=userGensAll(a,pIdx); bv=userGensAll(b,pIdx);
          return (av-bv)*dir;
        default: return 0;
      }
    });
  }

  function userSortTh(label,colKey){
    var th=el('th',{className:'adm-sortable'+(userSortCol===colKey?' adm-sorted':'')});
    th.appendChild(document.createTextNode(label));
    th.appendChild(el('span',{className:'adm-sort-arrow',textContent:userSortCol===colKey?(userSortDir==='asc'?'\u2191':'\u2193'):'\u2195'}));
    th.addEventListener('click',function(e){
      e.stopPropagation();
      if(userSortCol===colKey){userSortDir=userSortDir==='asc'?'desc':'asc'}
      else{userSortCol=colKey;userSortDir=(colKey==='email'||colKey==='plan'||colKey==='auth')?'asc':'desc'}
      renderUsers();
    });
    return th;
  }

  function renderUsers(filter){
    var pIdx=buildPromptIndex();
    var d30=daysAgo(30);
    var q=(filter||qs('#adm-user-search').value||'').toLowerCase();

    var list=data.users.slice();
    if(q)list=list.filter(function(u){return(u.email||'').toLowerCase().indexOf(q)!==-1});
    if(userFilter==='pro')list=list.filter(function(u){return effectivePlan(u)==='pro'});
    if(userFilter==='free')list=list.filter(function(u){return effectivePlan(u)==='free'});
    list=sortUserList(list,pIdx,d30);

    qs('#adm-user-count').textContent=list.length+' user'+(list.length!==1?'s':'');

    var wrap=qs('#adm-users-table');
    if(!list.length){wrap.innerHTML='<p style="color:#94a3b8;font-size:.85rem">No users found.</p>';return}

    var tbl=el('table',{className:'adm-table'});
    tbl.appendChild(el('thead',null,[el('tr',null,[
      userSortTh('Email','email'),userSortTh('Plan','plan'),userSortTh('Auth','auth'),
      userSortTh('Created','created'),userSortTh('Gens (30d)','gens30'),userSortTh('Gens (all)','gensAll')
    ])]));
    var tbody=el('tbody');

    list.forEach(function(u){
      var em=(u.email||'').toLowerCase();
      var allR=pIdx[em]||[];
      var c30=userGens30(u,pIdx,d30);
      var row=el('tr',{className:'adm-row-click'},[
        el('td',{textContent:u.email}),el('td',null,[badge(effectivePlan(u))]),el('td',null,[authBadge(u)]),
        el('td',{textContent:fmtDate(u.createdAt)}),
        el('td',{textContent:String(c30)}),el('td',{textContent:String(allR.length)})
      ]);

      row.addEventListener('click',function(){
        var nxt=row.nextElementSibling;
        if(nxt&&nxt.classList.contains('adm-detail-row')){nxt.remove();row.classList.remove('adm-row-expanded');return}
        var old=tbody.querySelector('.adm-detail-row');
        if(old){old.remove();var prev=tbody.querySelector('.adm-row-expanded');if(prev)prev.classList.remove('adm-row-expanded')}
        row.classList.add('adm-row-expanded');

        var td=el('td',{colspan:'6'});
        var det=el('div',{className:'adm-detail'});

        // info grid
        var ig=el('div',{className:'adm-detail-section'});
        ig.appendChild(el('h3',{textContent:'Account Details'}));
        var grid=el('div',{className:'adm-detail-info-grid'});
        var fields=[
          ['User ID',u.id],['Plan',effectivePlan(u)],['Created',fmtDateTime(u.createdAt)],
          ['Auth',u.googleSub?'Google ('+u.googleSub.slice(0,8)+'\u2026)':'Email/password'],
          u.stripeCustomerId?['Stripe Customer',u.stripeCustomerId]:null,
          u.stripeSubscriptionId?['Stripe Subscription',u.stripeSubscriptionId]:null,
          u.proPassGrantedAt?['Pro Pass Granted',fmtDateTime(u.proPassGrantedAt)]:null,
        ].filter(Boolean);
        fields.forEach(function(f){
          var kv=el('div',{className:'adm-detail-kv'});
          kv.appendChild(el('strong',{textContent:f[0]+': '}));
          kv.appendChild(document.createTextNode(f[1]));
          grid.appendChild(kv);
        });
        ig.appendChild(grid);det.appendChild(ig);

        // generations
        var gs=el('div',{className:'adm-detail-section'});
        gs.appendChild(el('h3',{textContent:'Generation History ('+allR.length+' total)'}));
        if(!allR.length){gs.appendChild(el('p',{className:'adm-detail-empty',textContent:'No generations found.'}))}
        else{
          var gt=el('table',{className:'adm-table'});
          gt.appendChild(el('thead',null,[el('tr',null,[el('th',{textContent:'When'}),el('th',{textContent:'Room'}),el('th',{textContent:'Style'}),el('th',{textContent:'Prompt'}),el('th',{textContent:'Remove?'})])]));
          var gb=el('tbody');
          allR.slice().sort(function(a,b){return new Date(b[0]).getTime()-new Date(a[0]).getTime()}).slice(0,50).forEach(function(r){
            gb.appendChild(el('tr',null,[
              el('td',{textContent:fmtDateTime(r[0])}),el('td',{textContent:r[1]||'\u2014'}),
              el('td',{textContent:r[2]||'\u2014'}),el('td',{textContent:(r[3]||'').slice(0,120)||'\u2014'}),
              el('td',{textContent:r[4]==='true'?'Yes':'No'})
            ]));
          });
          gt.appendChild(gb);
          if(allR.length>50)gs.appendChild(el('p',{style:'font-size:.72rem;color:#94a3b8;margin:0 0 .25rem',textContent:'Showing 50 of '+allR.length}));
          gs.appendChild(gt);
        }
        det.appendChild(gs);

        // chats
        var uid=u.id;
        var chats=data.chatRows.filter(function(r){return(r[1]||'').trim()===uid});
        var cs=el('div',{className:'adm-detail-section'});
        cs.appendChild(el('h3',{textContent:'Chat Messages ('+chats.length+')'}));
        if(!chats.length){cs.appendChild(el('p',{className:'adm-detail-empty',textContent:'No chat messages.'}))}
        else{
          var ct=el('table',{className:'adm-table'});
          ct.appendChild(el('thead',null,[el('tr',null,[el('th',{textContent:'When'}),el('th',{textContent:'Message'})])]));
          var cb=el('tbody');
          chats.slice().sort(function(a,b){return new Date(b[0]).getTime()-new Date(a[0]).getTime()}).slice(0,30).forEach(function(r){
            cb.appendChild(el('tr',null,[el('td',{textContent:fmtDateTime(r[0])}),el('td',{textContent:(r[2]||'').slice(0,250)||'\u2014'})]));
          });
          ct.appendChild(cb);cs.appendChild(ct);
        }
        det.appendChild(cs);

        // masks
        var masks=data.maskRows.filter(function(r){return(r[6]||'').trim()===uid});
        var ms=el('div',{className:'adm-detail-section'});
        ms.appendChild(el('h3',{textContent:'Mask Edits ('+masks.length+')'}));
        if(!masks.length){ms.appendChild(el('p',{className:'adm-detail-empty',textContent:'No mask edits.'}))}
        else{
          var mt=el('table',{className:'adm-table'});
          mt.appendChild(el('thead',null,[el('tr',null,[el('th',{textContent:'When'}),el('th',{textContent:'Prompt'}),el('th',{textContent:'Model'})])]));
          var mb=el('tbody');
          masks.slice().sort(function(a,b){return new Date(b[0]).getTime()-new Date(a[0]).getTime()}).slice(0,30).forEach(function(r){
            mb.appendChild(el('tr',null,[el('td',{textContent:fmtDateTime(r[0])}),el('td',{textContent:(r[1]||'').slice(0,150)||'\u2014'}),el('td',{textContent:r[2]||'\u2014'})]));
          });
          mt.appendChild(mb);ms.appendChild(mt);
        }
        det.appendChild(ms);

        td.appendChild(det);
        var dr=el('tr',{className:'adm-detail-row'},[td]);
        row.after(dr);
      });
      tbody.appendChild(row);
    });
    tbl.appendChild(tbody);wrap.innerHTML='';wrap.appendChild(tbl);
  }

  // ── Enterprise ──

  function renderEnterprise(){
    var wrap=qs('#adm-ent-table');
    if(!data.enterprise.length){wrap.innerHTML='<p style="color:#94a3b8;font-size:.85rem">No enterprise domains configured.</p>';return}

    // Summary bar
    var totalUses=data.enterprise.reduce(function(s,e){return s+(e.usageCount||0)},0);
    var totalRev=(totalUses*0.15).toFixed(2);
    var summary=el('div',{style:'display:flex;gap:1.5rem;flex-wrap:wrap;margin-bottom:1rem'});
    [[totalUses+' total uses','#1e3a8a'],['$'+totalRev+' total revenue','#065f46']].forEach(function(item){
      summary.appendChild(el('div',{style:'background:rgba(255,255,255,.7);border:1px solid #e2e8f0;border-radius:10px;padding:.5rem 1rem;font-size:.85rem;font-weight:700;color:'+item[1],textContent:item[0]}));
    });

    var tbl=el('table',{className:'adm-table'});
    tbl.appendChild(el('thead',null,[el('tr',null,[
      el('th',{textContent:'Domain'}),el('th',{textContent:'Company'}),el('th',{textContent:'Contact'}),
      el('th',{textContent:'Status'}),el('th',{textContent:'Uses'}),el('th',{textContent:'Revenue ($0.15/use)'}),
      el('th',{textContent:'Stripe Customer'}),el('th',{textContent:'Created'})
    ])]));
    var tb=el('tbody');
    data.enterprise.forEach(function(e){
      var uses=e.usageCount||0;
      var rev='$'+(uses*0.15).toFixed(2);
      tb.appendChild(el('tr',null,[
        el('td',{textContent:e.domain}),el('td',{textContent:e.companyName||'\u2014'}),
        el('td',{textContent:e.contactEmail||'\u2014'}),
        el('td',null,[statusBadge(e.status)]),
        el('td',{textContent:uses.toLocaleString(),style:'font-weight:600;color:#1e3a8a'}),
        el('td',{textContent:rev,style:'font-weight:600;color:#065f46'}),
        el('td',{textContent:e.stripeCustomerId||'\u2014'}),
        el('td',{textContent:fmtDate(e.createdAt)})
      ]));
    });
    tbl.appendChild(tb);
    wrap.innerHTML='';
    wrap.appendChild(summary);
    wrap.appendChild(tbl);
  }

  // ── Contacts ──

  function renderContacts(filter){
    var q=(filter||'').toLowerCase();
    var rows=data.contactRows.slice();
    if(q)rows=rows.filter(function(r){return r.join(' ').toLowerCase().indexOf(q)!==-1});
    rows.sort(function(a,b){return new Date(b[0]).getTime()-new Date(a[0]).getTime()});
    qs('#adm-contact-count').textContent=rows.length+' contact'+(rows.length!==1?'s':'');

    var wrap=qs('#adm-contacts-table');
    if(!rows.length){wrap.innerHTML='<p style="color:#94a3b8;font-size:.85rem">No contact submissions.</p>';return}
    var tbl=el('table',{className:'adm-table'});
    tbl.appendChild(el('thead',null,[el('tr',null,[
      el('th',{textContent:'When'}),el('th',{textContent:'Email'}),el('th',{textContent:'Role'}),
      el('th',{textContent:'Referral'}),el('th',{textContent:'User Agent'})
    ])]));
    var tb=el('tbody');
    rows.slice(0,200).forEach(function(r){
      tb.appendChild(el('tr',null,[
        el('td',{textContent:fmtDateTime(r[0])}),el('td',{textContent:r[3]||'\u2014'}),
        el('td',{textContent:r[1]||'\u2014'}),el('td',{textContent:r[2]||'\u2014'}),
        el('td',{textContent:(r[4]||'').slice(0,60)||'\u2014'})
      ]));
    });
    tbl.appendChild(tb);wrap.innerHTML='';
    if(rows.length>200)wrap.appendChild(el('p',{style:'font-size:.72rem;color:#94a3b8;margin:0 0 .5rem',textContent:'Showing 200 of '+rows.length}));
    wrap.appendChild(tbl);
  }

  function isStrictEmailClientProxyUa(ua){
    var s=String(ua||'').toLowerCase().trim();
    if(!s||s==='unknown')return false;
    var bots=['curl/','wget/','python-','go-http-client','bot','crawler','spider','scanner','preview','proofpoint','barracuda','mimecast','cloudflare'];
    for(var i=0;i<bots.length;i++){if(s.indexOf(bots[i])!==-1)return false}
    if(s.indexOf('googleimageproxy')!==-1||s.indexOf('ggpht.com')!==-1)return true;
    if(s.indexOf('yahoo! slurp')!==-1||s.indexOf('yahoomailproxy')!==-1)return true;
    if(s.indexOf('microsoft office')!==-1||s.indexOf('ms-office')!==-1||s.indexOf('outlook')!==-1)return true;
    return false;
  }

  function getOpenedEmails(){
    var byEmail={};
    data.emailOpenRows.forEach(function(r){
      if(!r[0]||r[0]==='timestamp')return;
      if(!isStrictEmailClientProxyUa(r[3]))return;
      var em=(r[1]||'').trim().toLowerCase();
      if(!em)return;
      if(!byEmail[em]||new Date(r[0])<new Date(byEmail[em].openedAt)){
        byEmail[em]={email:em,openedAt:r[0],ua:r[3]||''};
      }
    });
    return Object.keys(byEmail).map(function(k){return byEmail[k]}).sort(function(a,b){return new Date(b.openedAt).getTime()-new Date(a.openedAt).getTime()});
  }

  // ── Email Opens ──

  function renderEmailOpens(filter){
    var q=(filter||'').toLowerCase();
    var rows=getOpenedEmails();
    if(q)rows=rows.filter(function(r){return r.email.indexOf(q)!==-1});

    qs('#adm-email-open-count').textContent=rows.length;

    var summaryWrap=qs('#adm-email-open-summary');
    summaryWrap.innerHTML='';
    if(rows.length){
      summaryWrap.appendChild(el('div',{style:'background:rgba(255,255,255,.7);border:1px solid #e2e8f0;border-radius:10px;padding:.5rem 1rem;font-size:.85rem;font-weight:700;color:#065f46',textContent:rows.length+' recipient'+(rows.length!==1?'s':'')+' opened your email'}));
    }

    var wrap=qs('#adm-email-opens-table');
    if(!rows.length){wrap.innerHTML='<p style="color:#94a3b8;font-size:.85rem">No confirmed opens yet.</p>';return}
    var tbl=el('table',{className:'adm-table'});
    tbl.appendChild(el('thead',null,[el('tr',null,[
      el('th',{textContent:'Email'}),el('th',{textContent:'Opened'}),
      el('th',{textContent:'Opened At'}),el('th',{textContent:'Client'})
    ])]));
    var tb=el('tbody');
    rows.forEach(function(r){
      tb.appendChild(el('tr',null,[
        el('td',{textContent:r.email}),
        el('td',null,[el('span',{className:'adm-badge adm-badge-pro',textContent:'Yes'})]),
        el('td',{textContent:fmtDateTime(r.openedAt)}),
        el('td',{textContent:(r.ua||'').slice(0,70)||'\u2014'})
      ]));
    });
    tbl.appendChild(tb);wrap.innerHTML='';wrap.appendChild(tbl);
  }

  // ── Bug Reports ──

  function renderBugs(filter){
    var q=(filter||'').toLowerCase();
    var rows=data.bugRows.slice();
    if(q)rows=rows.filter(function(r){return r.join(' ').toLowerCase().indexOf(q)!==-1});
    rows.sort(function(a,b){return new Date(b[0]).getTime()-new Date(a[0]).getTime()});
    qs('#adm-bug-count').textContent=rows.length+' report'+(rows.length!==1?'s':'');

    var wrap=qs('#adm-bugs-table');
    if(!rows.length){wrap.innerHTML='<p style="color:#94a3b8;font-size:.85rem">No bug reports.</p>';return}
    var tbl=el('table',{className:'adm-table'});
    tbl.appendChild(el('thead',null,[el('tr',null,[
      el('th',{textContent:'When'}),el('th',{textContent:'Email'}),
      el('th',{textContent:'Description'}),el('th',{textContent:'Steps'}),el('th',{textContent:'URL'})
    ])]));
    var tb=el('tbody');
    rows.slice(0,100).forEach(function(r){
      tb.appendChild(el('tr',null,[
        el('td',{textContent:fmtDateTime(r[0])}),el('td',{textContent:r[3]||'\u2014'}),
        el('td',{textContent:(r[1]||'').slice(0,180)||'\u2014'}),
        el('td',{textContent:(r[2]||'').slice(0,140)||'\u2014'}),
        el('td',{textContent:r[6]||'\u2014'})
      ]));
    });
    tbl.appendChild(tb);wrap.innerHTML='';
    if(rows.length>100)wrap.appendChild(el('p',{style:'font-size:.72rem;color:#94a3b8;margin:0 0 .5rem',textContent:'Showing 100 of '+rows.length}));
    wrap.appendChild(tbl);
  }

  // ── Image Hosting ──

  function fmtBytes(n){
    n=Number(n)||0;
    if(n<1024)return n+' B';
    if(n<1048576)return (n/1024).toFixed(1)+' KB';
    return (n/1048576).toFixed(1)+' MB';
  }

  function fallbackCopy(text){
    try{
      var ta=document.createElement('textarea');
      ta.value=text;ta.style.position='fixed';ta.style.opacity='0';
      document.body.appendChild(ta);ta.focus();ta.select();
      document.execCommand('copy');document.body.removeChild(ta);
    }catch(e){}
  }

  function copyToClipboard(text,btn){
    var done=function(){if(!btn)return;var o=btn.textContent;btn.textContent='Copied!';setTimeout(function(){btn.textContent=o},1200)};
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(done).catch(function(){fallbackCopy(text);done()});
    }else{fallbackCopy(text);done()}
  }

  function fullHostUrl(img){return location.origin+(img.path||('/i/'+img.id))}

  function renderHosting(){
    var wrap=qs('#adm-hosting-list');if(!wrap)return;
    var list=data.hostedImages||[];
    qs('#adm-host-count').textContent=list.length;
    if(!list.length){wrap.innerHTML='<p style="color:#94a3b8;font-size:.85rem">No hosted images yet. Upload one above to get a public link.</p>';return}
    wrap.innerHTML='';
    var grid=el('div',{className:'adm-host-grid'});
    list.forEach(function(img){
      var url=fullHostUrl(img);
      var item=el('div',{className:'adm-host-item'});

      var a=el('a',{href:url,target:'_blank',rel:'noopener noreferrer'},[
        el('img',{className:'adm-host-thumb',src:url,alt:img.originalName||img.id,loading:'lazy'})
      ]);
      item.appendChild(a);

      var body=el('div',{className:'adm-host-body'});
      var urlRow=el('div',{className:'adm-host-url-row'});
      urlRow.appendChild(el('div',{className:'adm-host-url',title:url,textContent:url}));
      var copyBtn=el('button',{className:'adm-host-copy',type:'button',textContent:'Copy'});
      copyBtn.addEventListener('click',function(){copyToClipboard(url,copyBtn)});
      urlRow.appendChild(copyBtn);
      body.appendChild(urlRow);

      body.appendChild(el('div',{className:'adm-host-meta',textContent:(img.originalName||'image')+' · '+fmtBytes(img.size)+' · '+fmtDate(img.uploadedAt)}));

      var actions=el('div',{className:'adm-host-actions'});
      actions.appendChild(el('a',{className:'adm-host-copy',href:url,target:'_blank',rel:'noopener noreferrer',textContent:'Open'}));
      var delBtn=el('button',{className:'adm-host-del',type:'button',textContent:'Delete'});
      delBtn.addEventListener('click',function(){deleteHosted(img,delBtn)});
      actions.appendChild(delBtn);
      body.appendChild(actions);

      item.appendChild(body);
      grid.appendChild(item);
    });
    wrap.appendChild(grid);
  }

  function deleteHosted(img,btn){
    if(!confirm('Delete and unhost this image?\n\n'+(img.originalName||img.id)+'\n\nThe public link will stop working immediately.'))return;
    if(btn){btn.disabled=true;btn.textContent='Deleting…'}
    apiSend('/api/hosted-images/'+encodeURIComponent(img.id),'DELETE').then(function(){
      data.hostedImages=(data.hostedImages||[]).filter(function(x){return x.id!==img.id});
      updateTabCounts();renderHosting();
    }).catch(function(e){
      alert('Delete failed: '+e.message);
      if(btn){btn.disabled=false;btn.textContent='Delete'}
    });
  }

  // ── Downloads (secure blob-based) ──

  function renderDownloads(){
    var files=[
      {label:'Prompt Logs',url:'/promptlogs',file:'prompt_logs.csv'},
      {label:'Contact Logs',url:'/contactlogs',file:'contact_logs.csv'},
      {label:'Email Open Logs',url:'/email-open-logs',file:'email_open_logs.csv'},
      {label:'Chat Logs',url:'/chatlogs',file:'chat_logs.csv'},
      {label:'Bug Reports',url:'/bugreports',file:'bug_reports.csv'},
      {label:'Mask Logs',url:'/masklogs',file:'mask_logs.csv'},
      {label:'Auth Store',url:'/authstore',file:'auth-store.json'},
      {label:'Enterprise Domains',url:'/enterprise-domains',file:'enterprise-domains.json'},
    ];
    var grid=qs('#adm-dl-grid');grid.innerHTML='';
    files.forEach(function(f){
      var btn=el('button',{className:'adm-dl-btn'});
      btn.innerHTML=ICONS.dl+' '+esc(f.label);
      btn.addEventListener('click',function(){
        btn.classList.add('adm-dl-btn--downloading');
        btn.innerHTML=ICONS.dl+' Downloading\u2026';
        secureBlobDownload(f.url,f.file).then(function(){
          btn.innerHTML=ICONS.dl+' '+esc(f.label);
          btn.classList.remove('adm-dl-btn--downloading');
        }).catch(function(){
          btn.innerHTML=ICONS.dl+' '+esc(f.label);
          btn.classList.remove('adm-dl-btn--downloading');
          alert('Download failed for '+f.file);
        });
      });
      grid.appendChild(btn);
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
      userFilter=btn.dataset.filter;
      qsa('.adm-filter').forEach(function(b){b.classList.toggle('active',b.dataset.filter===userFilter)});
      renderUsers();
    });
  });
  qs('#adm-filter-all').classList.add('active');

  // ── Search ──

  qs('#adm-user-search').addEventListener('input',function(){renderUsers(this.value)});
  qs('#adm-bug-search').addEventListener('input',function(){renderBugs(this.value)});
  qs('#adm-contact-search').addEventListener('input',function(){renderContacts(this.value)});
  qs('#adm-email-open-search').addEventListener('input',function(){renderEmailOpens(this.value)});

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
      if(j.entry){data.hostedImages.unshift(Object.assign({},j.entry,{path:j.path||('/i/'+j.id)}))}
      updateTabCounts();renderHosting();
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
    data={users:[],promptRows:[],chatRows:[],bugRows:[],maskRows:[],contactRows:[],emailOpenRows:[],enterprise:[],hostedImages:[]};
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
