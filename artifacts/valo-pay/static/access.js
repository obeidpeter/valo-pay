(function(){"use strict";
var d=document;
// Error focus + field wiring
var sum=d.getElementById("errsum");if(sum)sum.focus();
d.querySelectorAll("[data-field]").forEach(function(w){
  var i=w.querySelector("input,select,textarea");if(!i)return;
  var ids=[];var h=w.querySelector(".hint[id]"),e=w.querySelector(".err[id]");
  if(h)ids.push(h.id);if(e){ids.push(e.id);i.setAttribute("aria-invalid","true");}
  if(ids.length)i.setAttribute("aria-describedby",ids.join(" "));
  i.style.width="100%";i.style.minHeight="44px";
  if(i.type==="password"){
    var b=d.createElement("button");b.type="button";b.className="btn ghost sm";b.style.marginTop="8px";
    b.textContent="Show password";b.setAttribute("aria-pressed","false");b.setAttribute("aria-controls",i.id);
    b.addEventListener("click",function(){var s=i.type==="password";i.type=s?"text":"password";
      b.textContent=s?"Hide password":"Show password";b.setAttribute("aria-pressed",String(s));});
    i.insertAdjacentElement("afterend",b);
  }
  if(i.name==="code"){i.setAttribute("autocomplete","one-time-code");}
});
// Prevent double submit (no replay)
d.querySelectorAll("form[method=post]").forEach(function(f){f.addEventListener("submit",function(){
  var b=f.querySelector("button[type=submit]");if(b){if(b.getAttribute("aria-busy")==="true")return;setTimeout(function(){b.setAttribute("aria-busy","true");b.disabled=true;},0);}});});
// Copy setup key (no storage)
d.querySelectorAll("[data-copy]").forEach(function(b){b.addEventListener("click",function(){
  var i=d.getElementById(b.getAttribute("data-copy")),st=b.parentNode.querySelector("[data-copy-status]");
  i.focus();i.select();var ok=false;
  if(navigator.clipboard){navigator.clipboard.writeText(i.value).then(function(){st.textContent="Copied.";},function(){st.textContent="Select the key and copy it manually.";});return;}
  try{ok=d.execCommand("copy");}catch(x){}st.textContent=ok?"Copied.":"Select the key and copy it manually.";});});
// Idle warning
var box=d.getElementById("idle");if(!box)return;
var end=Date.now()+Number(box.dataset.remaining||0)*1000,shown=false,last=null;
var msg=d.getElementById("idle-msg"),clock=d.getElementById("idle-clock");
var lastInput=0;
d.addEventListener("input",function(e){
  if(!e.isTrusted||d.hidden||Date.now()-lastInput<60000)return;
  var csrf=d.querySelector("#idle input[name=csrfmiddlewaretoken]");
  if(!csrf)return;
  lastInput=Date.now();
  fetch("/access/continue/",{method:"POST",credentials:"same-origin",redirect:"error",
    headers:{"X-CSRFToken":csrf.value,"X-Valo-Activity":"input"}})
    .then(function(r){if(!r.ok)throw Error("Session not renewed");return r.json();})
    .then(function(data){end=Date.now()+data.remaining*1000;box.hidden=true;shown=false;last=null;})
    .catch(function(){/* Never claim renewal without server confirmation. */});
});
function fmt(s){return Math.floor(s/60)+":"+("0"+s%60).slice(-2);}
function tick(){var s=Math.max(0,Math.round((end-Date.now())/1000));
  if(s<=0){location.assign("/access/login/?expired=1");return;}
  if(s<=120){
    if(!shown){shown=true;box.hidden=false;box.querySelector("button").focus();}
    clock.textContent=fmt(s);
    var mark=s>60?120:s>30?60:s>10?30:10;
    if(mark!==last&&s<=mark){last=mark;msg.textContent="Your session will end in about "+(mark>=60?(mark/60)+" minute"+(mark>60?"s":""):mark+" seconds")+" because of inactivity. Choose Stay signed in to continue.";}
  }
  setTimeout(tick,1000);}
tick();
})();
