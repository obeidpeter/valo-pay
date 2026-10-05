/* Valo Pay progressive enhancement. Everything works without JS. */
(function(){
var live=document.getElementById("live");
function say(t){if(!live)return;live.textContent="";setTimeout(function(){live.textContent=t},50)}
document.addEventListener("click",function(e){
  var b=e.target.closest("[data-copy]");if(!b)return;
  var i=document.getElementById(b.getAttribute("data-copy"));if(!i)return;
  i.select();
  var done=function(){var t=b.textContent;b.textContent="Copied";say("Link copied to clipboard");setTimeout(function(){b.textContent=t},1600)};
  var fail=function(){say("Copy failed. Select the link text and copy it manually.")};
  if(navigator.clipboard){navigator.clipboard.writeText(i.value).then(done,function(){try{document.execCommand("copy")?done():fail()}catch(x){fail()}})}
  else{try{document.execCommand("copy")?done():fail()}catch(x){fail()}}
});
document.addEventListener("change",function(e){
  if(e.target.id!=="csv_file")return;var f=e.target.files[0];if(!f)return;
  var r=new FileReader();
  r.onload=function(){var t=document.getElementById("csv_data");if(t){t.value=r.result;say("File loaded into the CSV box. Choose Validate to check it.")}};
  r.onerror=function(){say("The file could not be read. Paste the CSV text instead.")};
  r.readAsText(f);
});
/* Confirmation + duplicate-submit guard. Server-side checks remain the real protection. */
document.addEventListener("submit",function(e){
  var f=e.target,m=f.getAttribute("data-confirm");
  if(m&&!window.confirm(m)){e.preventDefault();return}
  if(f.method.toLowerCase()!=="post")return;
  if(f.dataset.sent){e.preventDefault();say("Already submitting. Please wait for the result.");return}
  f.dataset.sent="1";
  var b=e.submitter||f.querySelector("button[type=submit]");
  if(b){setTimeout(function(){b.setAttribute("aria-busy","true");b.setAttribute("aria-disabled","true");b.dataset.label=b.textContent;b.textContent="Submitting…"},0)}
  say("Submitting. Waiting for the server response.");
});
/* restore forms if user navigates back (bfcache) */
window.addEventListener("pageshow",function(){document.querySelectorAll("form[data-sent]").forEach(function(f){delete f.dataset.sent;f.querySelectorAll("[aria-busy]").forEach(function(b){b.removeAttribute("aria-busy");b.removeAttribute("aria-disabled");if(b.dataset.label)b.textContent=b.dataset.label})})});
document.querySelectorAll("input[data-abs]").forEach(function(i){if(i.value.charAt(0)==="/")i.value=location.origin+i.value});
/* mobile staff navigation disclosure: real button, state, Escape and focus return */
var side=document.querySelector(".side"),mt=side&&side.querySelector(".menu-toggle"),panel=document.getElementById("sidepanel");
if(mt&&panel){mt.hidden=false;
  function setOpen(o,focusBack){if(o){side.setAttribute("data-open","")}else{side.removeAttribute("data-open");panel.querySelectorAll("details[open]").forEach(function(d){d.open=false})}mt.setAttribute("aria-expanded",o?"true":"false");if(o){var first=panel.querySelector(".nav a");if(first&&window.matchMedia("(max-width:900px)").matches)first.focus()}else if(focusBack){mt.focus()}}
  mt.addEventListener("click",function(){setOpen(!side.hasAttribute("data-open"))});
  document.addEventListener("keydown",function(e){if(e.key==="Escape"&&side.hasAttribute("data-open")){setOpen(false,true)}});
  window.matchMedia("(max-width:900px)").addEventListener("change",function(e){var focused=document.activeElement;if(e.matches){setOpen(false,panel.contains(focused))}else if(focused===mt){panel.querySelector(".nav a").focus()}});
}
/* account menu inside the scrollable desktop sidebar: keep the opened menu fully in view */
document.querySelectorAll("details.acct").forEach(function(d){d.addEventListener("toggle",function(){if(d.open){var u=d.querySelector("ul");if(u&&u.scrollIntoView)u.scrollIntoView({block:"nearest"})}})});
/* stacked tables: copy column headers to cells so narrow screens show labelled rows */
document.querySelectorAll("table.stack").forEach(function(t){var hs=[].map.call(t.querySelectorAll("thead th"),function(h){return h.textContent.trim()});t.querySelectorAll("tbody tr").forEach(function(r){[].forEach.call(r.children,function(c,i){if(!c.hasAttribute("data-label"))c.setAttribute("data-label",hs[i]||"")})})});
/* move focus to an error summary after a failed submission */
var es=document.querySelector(".errsum");if(es){es.focus()}
})();
