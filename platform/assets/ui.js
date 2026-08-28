(() => {
  const API = document.body.dataset.api || "/api/tender";
  const tabs = [["overview","Übersicht"],["tenders","Ausschreibungen"],["management-inbox","Management-Inbox"],["scheduler","Schedulerstatus"],["favorites","Favoriten"],["deadlines","Fristen"],["tasks","Aufgaben"],["reminders","Wiedervorlagen"],["sources","Quellen"],["imports","Importprotokolle"],["deadletters","Dead Letters"]];
  const nav=document.querySelector("#tabs"),out=document.querySelector("#content"),q=document.querySelector("#q"),source=document.querySelector("#source");
  let current="overview";
  const esc=(value)=>String(value??"").replace(/[&<>"']/g,(character)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[character]);
  const csrf=()=>decodeURIComponent(document.cookie.split("; ").find((item)=>item.startsWith("wb_csrf="))?.split("=").slice(1).join("=")||"");
  const errorMessage=(response,body)=>body.message||(response.status===401?"Anmeldung erforderlich":response.status===403?(body.error==="csrf_rejected"?"Sicherheitsprüfung abgelaufen – bitte Seite neu laden.":"Keine Berechtigung"):response.status===409?"Der Stand hat sich geändert – bitte neu laden.":response.status===423?"Diese rechtlich bindende Portalaktion ist gesperrt. Es wurde nichts übermittelt.":response.status>=500?"Interner Serverfehler":`Abruf fehlgeschlagen (${response.status})`);
  async function request(path,options={}){
    const mutating=options.method&&options.method!=="GET";
    const response=await fetch(API+path,{credentials:"same-origin",...options,headers:{...(mutating?{"x-csrf-token":csrf()}:{}),...(mutating&&options.body!=null?{"content-type":"application/json"}:{}),...(options.headers||{})}});
    let body={};try{body=await response.json()}catch{}
    if(!response.ok)throw Error(errorMessage(response,body));
    return body;
  }
  const cards=(rows)=>'<div class="grid">'+rows.map((item)=>'<article class="card"><h2>'+esc(item.title||item.tender_title||item.name||item.code||"Eintrag")+'</h2><p>'+esc(item.buyer||item.interface||item.company_name||"")+'</p><p class="muted">Quelle: '+esc(item.source_code||item.code||"–")+' · Frist: '+esc(item.offer_deadline||item.due_at||item.remind_at||"–")+'</p>'+(item.source_code?'<p><strong>'+(item.portal_access_connected?'Portalzugang vorhanden':'Nicht mit einem registrierten Portalzugang verbunden')+'</strong></p>':"")+'<p>'+esc(item.decision||item.workflow_status||"")+'</p>'+(item.tender_id||item.id&&item.source_code?'<button type="button" data-detail="'+esc(item.tender_id||item.id)+'">Details</button>':"")+(item.source_code&&item.portal_navigation_href?'<a class="button-link" data-portal-navigation="'+esc(item.portal_navigation_mode||"search")+'" href="'+esc(item.portal_navigation_href)+'">Portalzugang verwalten</a>':"")+'</article>').join("")+'</div>';
  const favoriteCard=(item)=>`<article class="card favorite-card" data-favorite-id="${esc(item.favorite_id)}"><h2>${esc(item.favorite_name||item.title||"Favorit")}</h2><p>${esc(item.buyer||"")}</p><dl><dt>Gesellschaft</dt><dd>${esc(item.company_name||"Allgemeiner Tenderkontext")}</dd><dt>Los</dt><dd>${esc(item.lot_title||item.lot_key||"Gesamt")}</dd><dt>Priorität</dt><dd>${esc(item.priority)}</dd></dl>${item.favorite_note?`<p data-favorite-note>${esc(item.favorite_note)}</p>`:""}<p class="muted">Zuordnung bleibt beim Bearbeiten unverändert.</p><div class="favorite-actions"><button type="button" data-detail="${esc(item.tender_id)}">Details</button><button type="button" data-favorite-edit>Bearbeiten</button><button type="button" data-favorite-remove>Entfernen</button></div><div data-favorite-form></div><p data-favorite-status role="status" aria-live="polite"></p></article>`;
  const favorites=(rows)=>rows.length?`<div class="grid favorite-grid">${rows.map(favoriteCard).join("")}</div>`:'<p class="muted" data-favorites-empty>Keine Favoriten gespeichert.</p>';
  async function load(){
    out.innerHTML='<p role="status">Wird geladen …</p>';
    try{
      let data;
      if(["overview","tenders","deadlines"].includes(current)){data=await request("/tenders?q="+encodeURIComponent(q.value)+"&source="+encodeURIComponent(source.value));out.innerHTML=cards(current==="deadlines"?data.items.filter((item)=>item.offer_deadline):data.items)}
      else if(current==="management-inbox"){data=await request("/management-inbox?source="+encodeURIComponent(source.value)+"&sort=relevance");out.innerHTML=cards(data.items)}
      else if(current==="scheduler"){data=await request("/scheduler/status");out.innerHTML='<div class="panel"><table><tbody>'+data.sources.map((item)=>'<tr><td>'+esc(item.source_code)+'</td><td>'+esc(item.kill_switch?"GESPERRT":item.enabled?"AKTIV":"INAKTIV")+'</td><td>'+esc(item.next_run_at||"Nicht geplant")+'</td></tr>').join("")+'</tbody></table></div>'}
      else if(current==="favorites"){data=await request("/favorites");out.innerHTML=favorites(data.items)}
      else if(current==="tasks"){data=await request("/tasks");out.innerHTML=cards(data.items)}
      else if(current==="reminders"){data=await request("/reminders");out.innerHTML=cards(data.items)}
      else{data=await request("/"+current);out.innerHTML='<div class="panel"><table><tbody>'+data.items.map((item)=>'<tr><td>'+esc(item.code||item.source_code||item.external_id||item.id)+'</td><td>'+esc(item.name||item.status||item.error_code||"")+'</td><td>'+esc(item.last_success_at||item.started_at||item.created_at||"")+'</td></tr>').join("")+'</tbody></table></div>'}
    }catch(error){out.innerHTML='<p class="error" role="alert">'+esc(error.message)+'</p>'}
  }
  async function detail(id){try{const item=await request("/tenders/"+encodeURIComponent(id)),e=item.sourceEvidence||{},source=e.source||{},notice=e.originalNotice,technical=e.technicalSource,portal=e.procurementPortal,account=e.account,docs=Array.isArray(e.documents)?e.documents:[],lots=Array.isArray(item.lots)?item.lots:[];const links=[notice?'<a rel="noopener noreferrer" target="_blank" href="'+esc(notice.url)+'">Originalbekanntmachung bei '+esc(source.displayName||item.source_code)+' öffnen</a>':"",technical?'<a rel="noopener noreferrer" target="_blank" href="'+esc(technical.url)+'">Maschinenlesbaren Quelldatensatz anzeigen</a>':"",portal?'<a rel="noopener noreferrer" target="_blank" href="'+esc(portal.url)+'">Tatsächliches Vergabeportal öffnen</a>':"",account?.login?'<a rel="noopener noreferrer" target="_blank" href="'+esc(account.login.url)+'">TED-Konto: Login</a>':"",account?.registration?'<a rel="noopener noreferrer" target="_blank" href="'+esc(account.registration.url)+'">TED-Konto: Registrierung</a>':"",...docs.slice(0,10).map(d=>'<a rel="noopener noreferrer" target="_blank" href="'+esc(d.url)+'">'+esc(d.label||"Dokument öffnen")+'</a>')].filter(Boolean);const portalText=portal?esc(portal.portalName||portal.canonicalHost||"ermittelt"):"in Quelldaten nicht eindeutig angegeben";out.innerHTML='<article class="panel"><button type="button" id="back">← Zurück</button><h1>'+esc(item.title)+'</h1><p>'+esc(item.buyer)+'</p><dl><dt>Veröffentlichungsquelle</dt><dd>'+esc(source.displayName||item.source_code||"–")+'</dd><dt>Tatsächliches Vergabeportal</dt><dd>'+portalText+'</dd><dt>Frist</dt><dd>'+esc(item.offer_deadline||"Nicht angegeben")+'</dd><dt>CPV</dt><dd>'+esc((item.cpv_codes||[]).join(", ")||"Nicht angegeben")+'</dd></dl><h2>Lose</h2>'+(lots.length?'<ul>'+lots.map(l=>'<li>'+esc(l.source_lot_id||"Los")+': '+esc(l.title||"")+' – '+esc(l.offer_deadline||"Frist nicht angegeben")+'</li>').join("")+'</ul>':'<p>Keine quellengebundene Losinformation vorhanden.</p>')+'<h2>Quellen und Dokumente</h2><div class="link-list">'+(links.length?links.map(x=>'<p>'+x+'</p>').join(""):'<p>Keine belegten Links vorhanden.</p>')+'</div>'+(e.missingReasons?.procurementPortal?'<p class="muted">'+esc(e.missingReasons.procurementPortal)+'</p>':"")+'</article>';document.querySelector("#back").onclick=load}catch(error){out.innerHTML='<p class="error" role="alert">'+esc(error.message)+'</p>'}}
  const editFavorite=(card)=>{
    const target=card.querySelector("[data-favorite-form]");
    const priority=card.querySelector("dd:last-of-type")?.textContent||"3";
    const name=card.querySelector("h2")?.textContent||"";
    const note=card.querySelector("[data-favorite-note]")?.textContent||"";
    target.innerHTML=`<form class="favorite-form"><label>Name<input name="name" maxlength="160" value="${esc(name)}"></label><label>Notiz<textarea name="note" maxlength="2000">${esc(note)}</textarea></label><label>Priorität<select name="priority">${[1,2,3,4,5].map((value)=>`<option value="${value}" ${String(value)===String(priority)?"selected":""}>${value}</option>`).join("")}</select></label><div class="favorite-actions"><button type="submit">Speichern</button><button type="button" data-favorite-cancel>Abbrechen</button></div></form>`;
    target.querySelector("input").focus();
  };
  out.addEventListener("click",async(event)=>{
    const detailId=event.target.closest("[data-detail]")?.dataset.detail;if(detailId){detail(detailId);return}
    const card=event.target.closest("[data-favorite-id]");if(!card)return;
    if(event.target.closest("[data-favorite-edit]")){editFavorite(card);return}
    if(event.target.closest("[data-favorite-cancel]")){card.querySelector("[data-favorite-form]").innerHTML="";return}
    if(event.target.closest("[data-favorite-remove]")){
      if(!window.confirm("Diesen Favoriten entfernen? Die Ausschreibung selbst bleibt unverändert."))return;
      const button=event.target.closest("button"),status=card.querySelector("[data-favorite-status]");button.disabled=true;status.textContent="Favorit wird entfernt …";
      try{await request("/favorites/"+encodeURIComponent(card.dataset.favoriteId),{method:"DELETE"});card.remove();if(!out.querySelector("[data-favorite-id]"))out.innerHTML='<p class="muted" data-favorites-empty>Keine Favoriten gespeichert.</p>'}catch(error){status.textContent="Entfernen fehlgeschlagen: "+error.message;button.disabled=false}
    }
  });
  out.addEventListener("submit",async(event)=>{
    if(!event.target.matches(".favorite-form"))return;event.preventDefault();
    const form=event.target,card=form.closest("[data-favorite-id]"),status=card.querySelector("[data-favorite-status]"),submit=form.querySelector('[type="submit"]');submit.disabled=true;status.textContent="Änderungen werden gespeichert …";
    const data=new FormData(form);
    try{const favoriteId=card.dataset.favoriteId;await request("/favorites/"+encodeURIComponent(favoriteId),{method:"PATCH",body:JSON.stringify({name:data.get("name"),note:data.get("note"),priority:Number(data.get("priority"))})});await load();const refreshed=out.querySelector(`[data-favorite-id="${CSS.escape(favoriteId)}"]`);if(refreshed)refreshed.querySelector("[data-favorite-status]").textContent="Favorit gespeichert."}catch(error){status.textContent="Speichern fehlgeschlagen: "+error.message;submit.disabled=false}
  });
  tabs.forEach(([id,label])=>{const button=document.createElement("button");button.type="button";button.textContent=label;button.onclick=()=>{current=id;[...nav.children].forEach((item)=>item.classList.remove("active"));button.classList.add("active");load()};nav.append(button)});
  nav.firstChild.classList.add("active");q.oninput=load;source.onchange=load;load();
})();
