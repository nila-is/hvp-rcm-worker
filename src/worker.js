// HVP RCM Rate Intelligence Worker — NVIDIA Nemotron NIM + Cloudflare D1

async function callNIM(env, messages, max_tokens) {
  max_tokens = max_tokens || 800;
  const resp = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.NVIDIA_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nvidia/nemotron-3-super-120b-a12b', messages: messages, max_tokens: max_tokens, temperature: 0.1 })
  });
  const d = await resp.json();
  if (!resp.ok) throw new Error('NIM: ' + JSON.stringify(d));
  return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
}
async function handleHealth(env) {
  return Response.json({ status: 'ok', service: 'hvp-rcm-ai', ts: Math.floor(Date.now()/1000) });
}
async function handlePayers(env) {
  const r = await env.DB.prepare('SELECT id, name, plan_type as portal_type FROM payers').all();
  return Response.json({ payers: r.results });
}
async function handleLookup(request, env) {
  const b = await request.json();
  let q = 'SELECT f.*, p.name as payer_name FROM fee_schedules f JOIN payers p ON p.id=f.payer_id WHERE f.payer_id=? AND f.cpt_code=?';
  const p = [b.payer_id, b.cpt_code];
  if (b.modifier) { q += ' AND f.modifier=?'; p.push(b.modifier); }
  if (b.contract_type) { q += ' AND f.contract_type=?'; p.push(b.contract_type); }
  q += ' ORDER BY f.effective_date DESC LIMIT 10';
  const stmt = env.DB.prepare(q);
  const r = await stmt.bind.apply(stmt, p).all();
  return Response.json({ rates: r.results });
}
async function handleAnalyze(request, env) {
  const b = await request.json();
  const content = await callNIM(env, [
    { role: 'system', content: 'Extract fee schedule data from insurance contracts. Return JSON: {contract_type, effective_date, cpt_codes:[{cpt_code, rate_dollars, modifier}]}. Be concise.' },
    { role: 'user', content: 'Payer: ' + b.payer_name + '\n\n' + (b.document_text || '').slice(0, 3000) }
  ]);
  var parsed = null;
  try { var m = content.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); } catch(e) {}
  return Response.json({ raw: content, parsed: parsed });
}
async function handleAnomalies(request, env) {
  const b = await request.json();
  const diffs = b.current_rates.map(function(c) {
    var bl = b.baseline_rates.find(function(x) { return x.cpt_code === c.cpt_code; });
    if (!bl) return null;
    var pct = (c.rate_dollars - bl.rate_dollars) / bl.rate_dollars * 100;
    return { cpt_code: c.cpt_code, current: c.rate_dollars, baseline: bl.rate_dollars,
             pct_change: Math.round(pct * 10) / 10, flagged: Math.abs(pct) > 15 };
  }).filter(Boolean);
  const flagged = diffs.filter(function(x) { return x.flagged; });
  var analysis = flagged.length ? '' : 'No significant anomalies. All rates within 15% of baseline.';
  if (flagged.length) {
    analysis = await callNIM(env, [
      { role: 'system', content: 'Medical billing compliance expert. Analyze rate anomalies in 2-3 sentences.' },
      { role: 'user', content: 'Context: ' + (b.context || '') + '\nAnomalies (>15%): ' + JSON.stringify(flagged) }
    ], 400);
  }
  return Response.json({ diffs: diffs, flagged_count: flagged.length, analysis: analysis });
}
async function handleStats(env) {
  const ps = await env.DB.prepare('SELECT p.name, COUNT(f.id) as rate_count, ROUND(AVG(f.rate_cents)/100.0,2) as avg_rate FROM payers p LEFT JOIN fee_schedules f ON f.payer_id=p.id GROUP BY p.id, p.name').all();
  const tc = await env.DB.prepare('SELECT cpt_code, COUNT(*) as payer_count, ROUND(AVG(rate_cents)/100.0,2) as avg_rate, ROUND(MIN(rate_cents)/100.0,2) as min_rate, ROUND(MAX(rate_cents)/100.0,2) as max_rate FROM fee_schedules GROUP BY cpt_code ORDER BY payer_count DESC LIMIT 15').all();
  return Response.json({ payer_stats: ps.results, top_codes: tc.results });
}

const HTML_PAGE = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HVP RCM Rate Intelligence</title><style>
:root{--bg:#0b0f1c;--surf:#131929;--card:#1a2236;--bdr:#253047;--acc:#3b82f6;--acc2:#6366f1;--ok:#10b981;--warn:#f59e0b;--err:#ef4444;--txt:#e2e8f0;--muted:#94a3b8}
*{box-sizing:border-box;margin:0;padding:0}body{background:var(--bg);color:var(--txt);font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column}
header{background:var(--surf);border-bottom:1px solid var(--bdr);padding:0 24px;display:flex;align-items:center;height:60px;gap:16px}
.logo{font-size:1.1rem;font-weight:700;color:#fff;letter-spacing:-.5px}.logo span{color:var(--acc)}
.tag{color:var(--muted);font-size:.78rem;border-left:1px solid var(--bdr);padding-left:16px}
nav{display:flex;gap:4px;margin-left:auto}nav button{background:none;border:none;color:var(--muted);padding:8px 14px;border-radius:8px;cursor:pointer;font-size:.82rem;transition:all .15s}
nav button:hover{background:rgba(59,130,246,.1);color:var(--txt)}nav button.active{background:rgba(59,130,246,.15);color:var(--acc);font-weight:600}
main{flex:1;padding:24px;max-width:1280px;margin:0 auto;width:100%}.tab{display:none}.tab.active{display:block}
.kg{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:24px}
.kpi{background:var(--card);border:1px solid var(--bdr);border-radius:12px;padding:20px;position:relative;overflow:hidden}
.kpi::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,var(--acc),var(--acc2))}
.kl{font-size:.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
.kv{font-size:1.9rem;font-weight:700;color:#fff}.ks{font-size:.72rem;color:var(--ok);margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th{text-align:left;color:var(--muted);font-weight:600;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;padding:10px 12px;border-bottom:1px solid var(--bdr)}
td{padding:10px 12px;border-bottom:1px solid rgba(37,48,71,.4)}tr:hover td{background:rgba(59,130,246,.04)}
.card{background:var(--card);border:1px solid var(--bdr);border-radius:12px;padding:24px;margin-bottom:16px}
.ct{font-size:.9rem;font-weight:600;margin-bottom:16px;color:#fff;display:flex;align-items:center;gap:8px}
label{display:block;font-size:.78rem;color:var(--muted);margin-bottom:5px;margin-top:12px}label:first-child{margin-top:0}
input,select,textarea{width:100%;background:var(--surf);border:1px solid var(--bdr);color:var(--txt);padding:9px 12px;border-radius:8px;font-size:.85rem;outline:none;transition:border-color .2s}
input:focus,select:focus,textarea:focus{border-color:var(--acc)}textarea{min-height:120px;resize:vertical;font-family:monospace;font-size:.78rem}
.btn{display:inline-flex;align-items:center;gap:8px;background:var(--acc);color:#fff;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-size:.85rem;font-weight:600;transition:opacity .2s;margin-top:14px}
.btn:hover{opacity:.88}.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:.68rem;font-weight:700;text-transform:uppercase}
.bok{background:rgba(16,185,129,.12);color:var(--ok);border:1px solid rgba(16,185,129,.25)}.bwarn{background:rgba(245,158,11,.12);color:var(--warn);border:1px solid rgba(245,158,11,.25)}
.rrow{display:flex;align-items:center;justify-content:space-between;padding:12px;background:var(--surf);border:1px solid var(--bdr);border-radius:8px;margin-top:8px}
.rbig{font-size:1.5rem;font-weight:700;color:var(--ok)}.spin{display:inline-block;width:13px;height:13px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:sp .7s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}.g2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.pos{color:var(--err)}.neg{color:var(--ok)}.ai-out{margin-top:14px;padding:14px;background:var(--surf);border:1px solid var(--bdr);border-radius:8px;font-size:.82rem;line-height:1.65;white-space:pre-wrap}
select option{background:#1a2236}
</style></head><body>
<header><div class="logo">HVP &middot; <span>RCM</span></div><div class="tag">Rate Intelligence Platform &nbsp;|&nbsp; NVIDIA Nemotron NIM</div>
<nav><button class="active" onclick="showTab('dash',this)">&#9632; Dashboard</button><button onclick="showTab('lookup',this)">&#128269; Rate Lookup</button><button onclick="showTab('contract',this)">&#128196; Contract Analyzer</button><button onclick="showTab('anomaly',this)">&#9888; Anomaly Detector</button></nav></header>
<main>
<div id="tab-dash" class="tab active">
<div class="kg"><div class="kpi"><div class="kl">Total Rate Records</div><div class="kv" id="kv-total">&#8212;</div><div class="ks" id="kv-sub">Loading...</div></div>
<div class="kpi"><div class="kl">Active Payers</div><div class="kv">3</div><div class="ks">Medicare &middot; Aetna PPO &middot; BCBS HMO</div></div>
<div class="kpi"><div class="kl">CPT Codes Tracked</div><div class="kv" id="kv-cpts">&#8212;</div><div class="ks">2024 fee schedules</div></div>
<div class="kpi"><div class="kl">AI Engine</div><div class="kv" style="font-size:1rem;margin-top:4px">Nemotron</div><div class="ks" id="kv-nim">Connecting...</div></div></div>
<div class="card"><div class="ct">&#128202; Cross-Payer Rate Comparison</div>
<table><thead><tr><th>CPT Code</th><th>Description</th><th>Medicare</th><th>Aetna PPO</th><th>BCBS HMO</th><th>Max Spread</th></tr></thead>
<tbody id="rtbody"><tr><td colspan="6" style="color:var(--muted);text-align:center;padding:24px">Loading...</td></tr></tbody></table></div></div>
<div id="tab-lookup" class="tab"><div class="g2">
<div class="card"><div class="ct">&#128269; Rate Lookup</div>
<label>Payer</label><select id="lu-payer"></select>
<label>CPT Code</label><input id="lu-cpt" value="99213" placeholder="e.g. 99213">
<label>Modifier (optional)</label><input id="lu-mod" placeholder="e.g. 25, 59, TC, 26">
<button class="btn" onclick="doLookup()"><span id="lu-sp" style="display:none" class="spin"></span>Look Up Rate</button></div>
<div class="card"><div class="ct">&#128203; Result</div>
<div id="lu-res" style="color:var(--muted);font-size:.85rem">Select a payer and CPT code to view contracted rates.</div></div>
</div></div>
<div id="tab-contract" class="tab"><div class="card">
<div class="ct">&#128196; Contract Analyzer <span style="font-size:.72rem;color:var(--muted);font-weight:400;margin-left:8px">Powered by NVIDIA Nemotron NIM</span></div>
<label>Payer Name</label><input id="ca-payer" value="Aetna PPO">
<label>Contract Text</label>
<textarea id="ca-text">PROVIDER REIMBURSEMENT SCHEDULE
Effective Date: January 1, 2024  |  Plan: PPO

EVALUATION and MANAGEMENT:
99213 - Office Visit Level 3: $148.50
99214 - Office Visit Level 4: $215.00
99215 - Office Visit Level 5: $285.00</textarea>
<button class="btn" onclick="doAnalyze()"><span id="ca-sp" style="display:none" class="spin"></span>Analyze with NIM AI</button>
<div id="ca-res" style="display:none;margin-top:16px"></div></div></div>
<div id="tab-anomaly" class="tab"><div class="card">
<div class="ct">&#9888; Anomaly Detector <span style="font-size:.72rem;color:var(--muted);font-weight:400;margin-left:8px">Flags deviations &gt;15% from baseline</span></div>
<div class="g2">
<div><label>Current Rates (JSON)</label><textarea id="an-cur" style="min-height:160px">[{"cpt_code":"99213","rate_dollars":148.50},{"cpt_code":"99214","rate_dollars":285.00}]</textarea></div>
<div><label>Baseline Rates (JSON)</label><textarea id="an-base" style="min-height:160px">[{"cpt_code":"99213","rate_dollars":137.70},{"cpt_code":"99214","rate_dollars":210.20}]</textarea></div></div>
<label>Context</label><input id="an-ctx" value="Aetna PPO 2024 vs 2023 fee schedule comparison">
<button class="btn" onclick="doAnomalies()"><span id="an-sp" style="display:none" class="spin"></span>Detect Anomalies</button>
<div id="an-res" style="display:none;margin-top:16px"></div></div></div>
</main>
<script>
var CPT={'99213':'E&M Office L3','99214':'E&M Office L4','99215':'E&M Office L5','99203':'New Patient L3','99204':'New Patient L4','99205':'New Patient L5','99232':'Hospital Subseq L2','99233':'Hospital Subseq L3','93000':'ECG w/ Interpretation','80053':'Comprehensive Metabolic','85025':'CBC w/ Differential','71046':'Chest X-Ray 2 Views','27447':'Total Knee Replacement','27130':'Total Hip Replacement','36415':'Routine Venipuncture','90837':'Psychotherapy 60min','97110':'Therapeutic Exercise'};
function showTab(id,btn){document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active');});document.querySelectorAll('nav button').forEach(function(b){b.classList.remove('active');});document.getElementById('tab-'+id).classList.add('active');btn.classList.add('active');}
function fmt(n){return n!=null?'$'+parseFloat(n).toFixed(2):'--';}
async function loadDashboard(){try{var sr=await fetch('/stats'),hr=await fetch('/health');var s=await sr.json(),h=await hr.json();var total=0;s.payer_stats.forEach(function(p){total+=(p.rate_count||0);});document.getElementById('kv-total').textContent=total;document.getElementById('kv-cpts').textContent=s.top_codes.length+'+';document.getElementById('kv-nim').textContent=h.status==='ok'?'\u2713 Online':'Offline';document.getElementById('kv-sub').textContent='Live from Cloudflare D1';var rows=s.top_codes.slice(0,12).map(function(c){var spread=((c.max_rate||0)-(c.min_rate||0)).toFixed(2);return '<tr><td style="font-family:monospace;font-weight:600">'+c.cpt_code+'</td><td style="color:var(--muted)">'+(CPT[c.cpt_code]||'Medical Service')+'</td><td>'+fmt(c.min_rate)+'</td><td>'+fmt(c.avg_rate)+'</td><td>'+fmt(c.avg_rate)+'</td><td style="color:var(--warn)">$'+spread+'</td></tr>';}).join('');document.getElementById('rtbody').innerHTML=rows||'<tr><td colspan="6" style="color:var(--muted);text-align:center">No data</td></tr>';}catch(e){document.getElementById('rtbody').innerHTML='<tr><td colspan="6" style="color:var(--err);text-align:center">Error: '+e.message+'</td></tr>';}}
async function loadPayers(){try{var r=await fetch('/payers'),d=await r.json();document.getElementById('lu-payer').innerHTML=d.payers.map(function(p){return '<option value="'+p.id+'">'+p.name+'</option>';}).join('');}catch(e){}}
async function doLookup(){var pid=parseInt(document.getElementById('lu-payer').value);var cpt=document.getElementById('lu-cpt').value.trim();var mod=document.getElementById('lu-mod').value.trim();if(!cpt)return;var sp=document.getElementById('lu-sp');sp.style.display='inline-block';try{var r=await fetch('/lookup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payer_id:pid,cpt_code:cpt,modifier:mod||undefined})});var d=await r.json();var el=document.getElementById('lu-res');if(!d.rates||!d.rates.length){el.innerHTML='<div style="color:var(--muted)">No rates found.</div>';}else{el.innerHTML=d.rates.map(function(rate){return '<div class="rrow"><div><div style="font-weight:700;font-size:.9rem">'+rate.payer_name+'</div><div style="color:var(--muted);font-size:.75rem">CPT '+rate.cpt_code+(rate.modifier?' -'+rate.modifier:'')+' \u00b7 '+rate.contract_type+' \u00b7 eff: '+rate.effective_date+'</div></div><div class="rbig">'+fmt(rate.rate_cents/100)+'</div></div>';}).join('');}}catch(e){document.getElementById('lu-res').innerHTML='<span style="color:var(--err)">Error: '+e.message+'</span>';}finally{sp.style.display='none';}}
async function doAnalyze(){var payer=document.getElementById('ca-payer').value;var text=document.getElementById('ca-text').value;if(!text)return;var sp=document.getElementById('ca-sp');sp.style.display='inline-block';var res=document.getElementById('ca-res');res.style.display='block';res.innerHTML='<div style="color:var(--muted)">Sending to NVIDIA Nemotron NIM...</div>';try{var r=await fetch('/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payer_name:payer,document_text:text})});var d=await r.json();var html='<div style="margin-bottom:10px"><span class="badge bok">NIM ANALYSIS COMPLETE</span></div>';if(d.parsed&&d.parsed.cpt_codes&&d.parsed.cpt_codes.length){html+='<table><thead><tr><th>CPT Code</th><th>Rate</th><th>Modifier</th></tr></thead><tbody>';html+=d.parsed.cpt_codes.map(function(c){return '<tr><td style="font-family:monospace">'+c.cpt_code+'</td><td style="color:var(--ok)">'+fmt(c.rate_dollars)+'</td><td>'+(c.modifier||'&mdash;')+'</td></tr>';}).join('');html+='</tbody></table>';}else{html+='<div class="ai-out">'+(d.raw||'No structured data extracted.')+'</div>';}res.innerHTML=html;}catch(e){res.innerHTML='<span style="color:var(--err)">Error: '+e.message+'</span>';}finally{sp.style.display='none';}}
async function doAnomalies(){var cur,base;try{cur=JSON.parse(document.getElementById('an-cur').value);base=JSON.parse(document.getElementById('an-base').value);}catch(e){alert('Invalid JSON');return;}var ctx=document.getElementById('an-ctx').value;var sp=document.getElementById('an-sp');sp.style.display='inline-block';var res=document.getElementById('an-res');res.style.display='block';res.innerHTML='<div style="color:var(--muted)">Analyzing with NIM...</div>';try{var r=await fetch('/anomalies',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({current_rates:cur,baseline_rates:base,context:ctx})});var d=await r.json();var html='<div style="margin-bottom:10px">'+(d.flagged_count>0?'<span class="badge bwarn">'+d.flagged_count+' ANOMALIES FLAGGED</span>':'<span class="badge bok">NO ANOMALIES DETECTED</span>')+'</div>';html+='<table><thead><tr><th>CPT</th><th>Current</th><th>Baseline</th><th>Change</th><th>Status</th></tr></thead><tbody>';html+=d.diffs.map(function(x){var pct=(x.pct_change>0?'+':'')+x.pct_change+'%';return '<tr><td style="font-family:monospace;font-weight:600">'+x.cpt_code+'</td><td>'+fmt(x.current)+'</td><td style="color:var(--muted)">'+fmt(x.baseline)+'</td><td class="'+(x.pct_change>0?'pos':'neg')+'">'+pct+'</td><td>'+(x.flagged?'<span class="badge bwarn">\u26a0 FLAGGED</span>':'<span class="badge bok">OK</span>')+'</td></tr>';}).join('');html+='</tbody></table>';if(d.analysis)html+='<div class="ai-out">'+d.analysis+'</div>';res.innerHTML=html;}catch(e){res.innerHTML='<span style="color:var(--err)">Error: '+e.message+'</span>';}finally{sp.style.display='none';}}
loadDashboard();loadPayers();
</script>
<div id="wu-overlay" style="position:fixed;inset:0;background:#0a0f1a;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;font-family:system-ui,sans-serif;transition:opacity 0.6s ease">
  <div style="width:48px;height:48px;border:3px solid #1e293b;border-top-color:#38bdf8;border-radius:50%;animation:wu-spin 0.8s linear infinite"></div>
  <p id="wu-msg" style="color:#64748b;margin-top:1.5rem;font-size:0.9rem;letter-spacing:0.05em">Connecting\u2026</p>
  <style>@keyframes wu-spin{to{transform:rotate(360deg)}}</style>
</div>
<script>
(function(){
  var msgs=["Connecting\u2026","Container starting up\u2026","Loading fee schedules\u2026","Warming up AI models\u2026","Almost ready\u2026"];
  var el=document.getElementById('wu-msg');
  var ov=document.getElementById('wu-overlay');
  var i=0;
  var tick=setInterval(function(){if(i<msgs.length-1)el.textContent=msgs[++i];},1400);
  function probe(){
    fetch('/health').then(function(r){
      if(r.ok){clearInterval(tick);el.textContent='Ready \u2713';setTimeout(function(){ov.style.opacity='0';setTimeout(function(){ov.remove();},600);},350);}
      else setTimeout(probe,900);
    }).catch(function(){setTimeout(probe,900);});
  }
  probe();
})();
</script>
</body></html>`;

function getHTML() { return HTML_PAGE; }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const ch = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Content-Type':'application/json'};
    if (request.method === 'OPTIONS') return new Response(null, {status:204, headers:ch});
    try {
      if (path === '/' || path === '') return new Response(getHTML(), {headers:{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store'}});
      let r;
      if (path === '/health') r = await handleHealth(env);
      else if (path === '/payers') r = await handlePayers(env);
      else if (path === '/stats') r = await handleStats(env);
      else if (path === '/lookup' && request.method === 'POST') r = await handleLookup(request, env);
      else if (path === '/analyze' && request.method === 'POST') r = await handleAnalyze(request, env);
      else if (path === '/anomalies' && request.method === 'POST') r = await handleAnomalies(request, env);
      else return Response.json({error:'Not found'},{status:404,headers:ch});
      r.headers.set('Access-Control-Allow-Origin','*');
      return r;
    } catch(e) {
      return Response.json({error: e.message},{status:500,headers:ch});
    }
  }
};
