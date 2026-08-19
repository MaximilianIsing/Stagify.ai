import {
  qs, el, esc, fmtDate, fmtDateTime, daysAgo,
  badge, statusBadge, authBadge, ICONS, fmtBytes, fullHostUrl,
  copyToClipboard, isStrictEmailClientProxyUa,
} from './helpers.js';
import { createGrantSection, grantActive } from './grant.js';
import { createDangerSection } from './danger.js';
import { createRendersPanel } from './renders-panel.js';
import { stripHeader } from './analytics.js';
import { activityIndexFrom, lastActiveMs, daysSinceActive } from './analytics-users.js';
import { createOverview } from './overview.js';
import { createInsights } from './insights.js';
import { createSignals } from './signals.js';
import { showErrorToast } from '../toast.js';

/**
 * All admin tab rendering plus the data-derived helpers, over a single shared
 * mutable context. `ctx.data` is swapped wholesale on sign-out, so everything
 * reads through `ctx` rather than capturing `ctx.data` up front.
 *
 * The two chart-heavy tabs live in their own islands (overview.js, insights.js);
 * this module keeps the table tabs and owns `effectivePlan`, which both of them
 * need and which depends on the enterprise-domain list in `ctx`.
 *
 * @param {object} deps
 * @param {{data: any, userFilter: string, userSortCol: string, userSortDir: string}} deps.ctx Shared app state.
 * @param {(url: string, method: string, body?: any, isForm?: boolean) => Promise<any>} deps.apiSend Mutating request helper (holds the session key).
 * @param {(url: string, filename: string) => Promise<void>} deps.secureBlobDownload Key-in-header blob download.
 */
export function createRenderers({ ctx, apiSend, secureBlobDownload }) {
  // True if the user gets Stagify+ via an active enterprise domain (not their own sub).
  function userEnterpriseActive(u){
    var dom=(u&&u.email||'').split('@')[1];
    if(!dom)return false;
    dom=dom.toLowerCase();
    return ctx.data.enterprise.some(function(e){
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

  var rendersSection=createRendersPanel({apiSend:apiSend});
  var grantSection=createGrantSection({apiSend:apiSend,onChanged:function(){renderUsers()}});
  // Erasure has no undo, so the row goes from the in-memory list immediately
  // rather than waiting for a refresh — leaving a deleted account on screen
  // invites a second click on an account that no longer exists.
  var dangerSection=createDangerSection({apiSend:apiSend,onDeleted:function(u){
    ctx.data.users=(ctx.data.users||[]).filter(function(x){return x.id!==u.id});
    updateTabCounts();
    renderUsers();
  }});
  var overview=createOverview({ctx:ctx,effectivePlan:effectivePlan});
  var insights=createInsights({ctx:ctx,effectivePlan:effectivePlan});
  var signals=createSignals({ctx:ctx,apiSend:apiSend,effectivePlan:effectivePlan});

  // A zero still shows — it means "checked, nothing there", which is not the same
  // as a missing chip — but it is de-emphasised so six zeroes in the rail don't
  // read with the same weight as a real backlog.
  function setTabCount(id,n){
    var e=qs(id);if(!e)return;
    e.textContent=n;
    e.classList.toggle('adm-tab-count--zero',!n);
  }

  function updateTabCounts(){
    setTabCount('#tc-users',ctx.data.users.length);
    setTabCount('#tc-ent',ctx.data.enterprise.length);
    setTabCount('#tc-bugs',stripHeader(ctx.data.bugRows).length);
    setTabCount('#tc-contacts',stripHeader(ctx.data.contactRows).length);
    setTabCount('#tc-email-opens',getOpenedEmails().length);
    setTabCount('#tc-hosting',ctx.data.hostedImages.length);
    // ACTIONABLE findings only. Including the 'working well' cards would
    // make this chip incapable of reading zero, which is the one value that
    // has to mean something.
    try{setTabCount('#tc-signals',signals.actionableCount())}catch(e){setTabCount('#tc-signals',0)}
  }

  // ── Prompt index ──

  // email → that account's render rows. Header-stripped, because the CSV's own
  // `…,email,…` header line would otherwise index itself as a user named "email".
  function buildPromptIndex(){
    var idx={};
    stripHeader(ctx.data.promptRows).forEach(function(r){
      var email=(r[7]||'').trim().toLowerCase();
      if(!email||email==='unknown')return;
      if(!idx[email])idx[email]=[];
      idx[email].push(r);
    });
    return idx;
  }

  // ── Render all ──

  function renderAll(){
    [overview.render,signals.render,signals.renderTeaser,insights.render,renderUsers,renderEnterprise,renderContacts,renderEmailOpens,renderBugs,renderHosting,renderDownloads].forEach(function(fn){
      try{fn()}catch(e){console.error('Admin render error in '+(fn.name||'renderer')+':',e)}
    });
  }

  // ── Users ──

  function userGens30(u, pIdx, d30){
    var allR=pIdx[(u.email||'').toLowerCase()]||[];
    return allR.filter(function(r){try{return new Date(r[0])>=d30}catch(e){return false}}).length;
  }

  function userGensAll(u, pIdx){
    return (pIdx[(u.email||'').toLowerCase()]||[]).length;
  }

  function sortUserList(list, pIdx, d30, actIdx){
    var dir=ctx.userSortDir==='asc'?1:-1;
    return list.sort(function(a,b){
      var av,bv;
      switch(ctx.userSortCol){
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
        case 'lastActive':
          // Never-active accounts sort as 0 so they cluster at one end rather
          // than scattering through the list on an unparseable date.
          av=lastActiveMs(a,actIdx)||0; bv=lastActiveMs(b,actIdx)||0;
          return (av-bv)*dir;
        default: return 0;
      }
    });
  }

  function userSortTh(label,colKey){
    var th=el('th',{className:'adm-sortable'+(ctx.userSortCol===colKey?' adm-sorted':'')});
    th.appendChild(document.createTextNode(label));
    th.appendChild(el('span',{className:'adm-sort-arrow',textContent:ctx.userSortCol===colKey?(ctx.userSortDir==='asc'?'\u2191':'\u2193'):'\u2195'}));
    th.addEventListener('click',function(e){
      e.stopPropagation();
      if(ctx.userSortCol===colKey){ctx.userSortDir=ctx.userSortDir==='asc'?'desc':'asc'}
      else{ctx.userSortCol=colKey;ctx.userSortDir=(colKey==='email'||colKey==='plan'||colKey==='auth')?'asc':'desc'}
      renderUsers();
    });
    return th;
  }

  // "Last active" is the newest signal across ALL three logs, and they key on two
  // different identifiers (renders by email, chat/mask by userId) — see
  // analytics-users.js. A never-active account is a real, common state here:
  // renders logged without an email can't be attributed to anyone, so "never"
  // means "never seen", not "never used the product".
  function lastActiveCell(u,actIdx){
    var days=daysSinceActive(u,actIdx);
    if(days===null)return el('td',null,[el('span',{className:'adm-stale adm-stale--never',textContent:'Never'})]);
    var cls=days>=90?'adm-stale--cold':days>=30?'adm-stale--warm':'adm-stale--fresh';
    var text=days===0?'Today':days===1?'Yesterday':days+'d ago';
    return el('td',null,[el('span',{className:'adm-stale '+cls,title:fmtDateTime(new Date(lastActiveMs(u,actIdx)).toISOString()),textContent:text})]);
  }

  function renderUsers(filter){
    var pIdx=buildPromptIndex();
    var actIdx=activityIndexFrom(ctx.data);
    var d30=daysAgo(30);
    var q=(filter||qs('#adm-user-search').value||'').toLowerCase();

    var list=ctx.data.users.slice();
    if(q)list=list.filter(function(u){return(u.email||'').toLowerCase().indexOf(q)!==-1});
    if(ctx.userFilter==='pro')list=list.filter(function(u){return effectivePlan(u)==='pro'});
    if(ctx.userFilter==='free')list=list.filter(function(u){return effectivePlan(u)==='free'});
    if(ctx.userFilter==='dormant')list=list.filter(function(u){var d=daysSinceActive(u,actIdx);return d!==null&&d>=30});
    if(ctx.userFilter==='never')list=list.filter(function(u){return daysSinceActive(u,actIdx)===null});
    list=sortUserList(list,pIdx,d30,actIdx);

    qs('#adm-user-count').textContent=list.length+' user'+(list.length!==1?'s':'');

    var wrap=qs('#adm-users-table');
    if(!list.length){wrap.innerHTML='<p class="adm-empty">No users found.</p>';return}

    var tbl=el('table',{className:'adm-table'});
    tbl.appendChild(el('thead',null,[el('tr',null,[
      userSortTh('Email','email'),userSortTh('Plan','plan'),userSortTh('Auth','auth'),
      userSortTh('Created','created'),userSortTh('Last active','lastActive'),
      userSortTh('Gens (30d)','gens30'),userSortTh('Gens (all)','gensAll')
    ])]));
    var tbody=el('tbody');

    list.forEach(function(u){
      var em=(u.email||'').toLowerCase();
      var allR=pIdx[em]||[];
      var c30=userGens30(u,pIdx,d30);
      var row=el('tr',{className:'adm-row-click'},[
        el('td',{textContent:u.email}),el('td',null,[badge(effectivePlan(u))]),el('td',null,[authBadge(u)]),
        el('td',{textContent:fmtDate(u.createdAt)}),
        lastActiveCell(u,actIdx),
        el('td',{className:'adm-num',textContent:String(c30)}),el('td',{className:'adm-num',textContent:String(allR.length)})
      ]);

      row.addEventListener('click',function(){
        var nxt=row.nextElementSibling;
        if(nxt&&nxt.classList.contains('adm-detail-row')){nxt.remove();row.classList.remove('adm-row-expanded');return}
        var old=tbody.querySelector('.adm-detail-row');
        if(old){old.remove();var prev=tbody.querySelector('.adm-row-expanded');if(prev)prev.classList.remove('adm-row-expanded')}
        row.classList.add('adm-row-expanded');

        var td=el('td',{colspan:'7'});
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
          grantActive(u)?['Free Month Ends',fmtDateTime(u.proGrantExpiresAt)]:null,
        ].filter(Boolean);
        fields.forEach(function(f){
          var kv=el('div',{className:'adm-detail-kv'});
          kv.appendChild(el('strong',{textContent:f[0]+': '}));
          kv.appendChild(document.createTextNode(f[1]));
          grid.appendChild(kv);
        });
        ig.appendChild(grid);det.appendChild(ig);
        det.appendChild(grantSection(u,effectivePlan(u)));

        // The pictures come before the text histories below: "what did it look
        // like" is the question a support thread actually opens with, and the
        // prompt list underneath is the same information without the answer.
        // Fetches on every expand — the URLs it gets back are short-lived
        // credentials and must not be cached (lib/data/s3-presign.js).
        det.appendChild(rendersSection(u));

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
          if(allR.length>50)gs.appendChild(el('p',{className:'adm-more',textContent:'Showing 50 of '+allR.length}));
          gs.appendChild(gt);
        }
        det.appendChild(gs);

        // chats
        var uid=u.id;
        var chats=stripHeader(ctx.data.chatRows).filter(function(r){return(r[1]||'').trim()===uid});
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
        var masks=stripHeader(ctx.data.maskRows).filter(function(r){return(r[6]||'').trim()===uid});
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

        // Last on purpose: everything above is information, and an operator
        // scrolling to read a user's history should not pass a delete button on
        // the way. Same separation the referrals panel keeps between Retire and
        // Delete permanently.
        det.appendChild(dangerSection(u));

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
    if(!ctx.data.enterprise.length){wrap.innerHTML='<p class="adm-empty">No enterprise domains configured.</p>';return}

    // Summary bar
    var totalUses=ctx.data.enterprise.reduce(function(s,e){return s+(e.usageCount||0)},0);
    var totalRev=(totalUses*0.15).toFixed(2);
    var summary=el('div',{className:'adm-summary'});
    [[totalUses.toLocaleString()+' total uses','adm-pill--blue'],['$'+totalRev+' total revenue','adm-pill--green']].forEach(function(item){
      summary.appendChild(el('div',{className:'adm-pill '+item[1],textContent:item[0]}));
    });

    var tbl=el('table',{className:'adm-table'});
    tbl.appendChild(el('thead',null,[el('tr',null,[
      el('th',{textContent:'Domain'}),el('th',{textContent:'Company'}),el('th',{textContent:'Contact'}),
      el('th',{textContent:'Status'}),el('th',{textContent:'Uses'}),el('th',{textContent:'Revenue ($0.15/use)'}),
      el('th',{textContent:'Stripe Customer'}),el('th',{textContent:'Created'})
    ])]));
    var tb=el('tbody');
    ctx.data.enterprise.forEach(function(e){
      var uses=e.usageCount||0;
      var rev='$'+(uses*0.15).toFixed(2);
      tb.appendChild(el('tr',null,[
        el('td',{textContent:e.domain}),el('td',{textContent:e.companyName||'\u2014'}),
        el('td',{textContent:e.contactEmail||'\u2014'}),
        el('td',null,[statusBadge(e.status)]),
        el('td',{className:'adm-num adm-num--blue',textContent:uses.toLocaleString()}),
        el('td',{className:'adm-num adm-num--green',textContent:rev}),
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
    var rows=stripHeader(ctx.data.contactRows).slice();
    if(q)rows=rows.filter(function(r){return r.join(' ').toLowerCase().indexOf(q)!==-1});
    rows.sort(function(a,b){return new Date(b[0]).getTime()-new Date(a[0]).getTime()});
    qs('#adm-contact-count').textContent=rows.length+' contact'+(rows.length!==1?'s':'');

    var wrap=qs('#adm-contacts-table');
    if(!rows.length){wrap.innerHTML='<p class="adm-empty">No contact submissions.</p>';return}
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
    if(rows.length>200)wrap.appendChild(el('p',{className:'adm-more',textContent:'Showing 200 of '+rows.length}));
    wrap.appendChild(tbl);
  }

  function getOpenedEmails(){
    var byEmail={};
    ctx.data.emailOpenRows.forEach(function(r){
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
      summaryWrap.appendChild(el('div',{className:'adm-pill adm-pill--green',textContent:rows.length+' recipient'+(rows.length!==1?'s':'')+' opened your email'}));
    }

    var wrap=qs('#adm-email-opens-table');
    if(!rows.length){wrap.innerHTML='<p class="adm-empty">No confirmed opens yet.</p>';return}
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
    var rows=stripHeader(ctx.data.bugRows).slice();
    if(q)rows=rows.filter(function(r){return r.join(' ').toLowerCase().indexOf(q)!==-1});
    rows.sort(function(a,b){return new Date(b[0]).getTime()-new Date(a[0]).getTime()});
    qs('#adm-bug-count').textContent=rows.length+' report'+(rows.length!==1?'s':'');

    var wrap=qs('#adm-bugs-table');
    if(!rows.length){wrap.innerHTML='<p class="adm-empty">No bug reports.</p>';return}
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
    if(rows.length>100)wrap.appendChild(el('p',{className:'adm-more',textContent:'Showing 100 of '+rows.length}));
    wrap.appendChild(tbl);
  }

  function renderHosting(){
    var wrap=qs('#adm-hosting-list');if(!wrap)return;
    var list=ctx.data.hostedImages||[];
    qs('#adm-host-count').textContent=list.length;
    if(!list.length){wrap.innerHTML='<p class="adm-empty">No hosted images yet. Upload one above to get a public link.</p>';return}
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
      ctx.data.hostedImages=(ctx.data.hostedImages||[]).filter(function(x){return x.id!==img.id});
      updateTabCounts();renderHosting();
    }).catch(function(e){
      showErrorToast('Delete failed: '+e.message);
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
      {label:'Rejection Logs',url:'/rejectionlogs',file:'rejection_logs.csv'},
      // No "Auth Store" entry: /authstore is now a redacted user list, not a
      // backup. The real backup is the SQLite file (Litestream → R2) — offering a
      // credential dump as a browser download is what made one leaked key fatal.
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
          showErrorToast('Download failed for '+f.file);
        });
      });
      grid.appendChild(btn);
    });
  }

  return {
    renderAll: renderAll,
    updateTabCounts: updateTabCounts,
    renderUsers: renderUsers,
    renderEnterprise: renderEnterprise,
    renderContacts: renderContacts,
    renderEmailOpens: renderEmailOpens,
    renderBugs: renderBugs,
    renderHosting: renderHosting,
    // Drops the memoized findings so the next render pass recomputes. Called by
    // admin.js once per data load and on sign-out, NOT per renderer — the rail
    // chip, the Overview teaser and the Signals panel must share one result.
    resetSignals: signals.reset,
  };
}
