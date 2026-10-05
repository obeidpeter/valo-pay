"""Browser measurements. Never screenshot secrets or write bearer URLs to reports."""
import json
from pathlib import Path
from urllib.parse import urlsplit


def audit_routes(page, base, borrower_url, consent_url):
    axe=Path("../../node_modules/axe-core/axe.min.js").resolve()
    results=[]
    routes=["/today/","/customers/","/import/","/collections/","/payments/","/payments/new/","/reviews/","/reports/","/settings/","/access/workspace/","/access/help/","/access/reset/","/access/login/","/","/request-demo/",borrower_url,consent_url]
    for route in routes:
        label="/pay/<redacted>/" if route==borrower_url else "/consent/<redacted>/" if route==consent_url else route
        page.goto(route if route.startswith("http") else base+route)
        for width in (320,360):
            page.set_viewport_size({"width":width,"height":850})
            page.emulate_media(reduced_motion="reduce")
            page.add_script_tag(path=str(axe))
            report=page.evaluate("async()=>({version:axe.version,violations:(await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}})).violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>n.target)}))})")
            overflow=page.evaluate("document.documentElement.scrollWidth>innerWidth")
            page.keyboard.press("Tab")
            focus=page.evaluate("document.activeElement.tagName")
            for _ in range(12):
                page.keyboard.press("Tab")
            page.keyboard.press("Shift+Tab")
            style=page.add_style_tag(content="*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}")
            spacing_overflow=page.evaluate("document.documentElement.scrollWidth>innerWidth")
            style.evaluate("(node)=>node.remove()")
            results.append({"route":label,"width":width,"axe":report,"overflow":overflow,"keyboard_focus":focus,
                "keyboard_forward_steps":13,"keyboard_backward_steps":1,"spacing_overflow":spacing_overflow,
                "reduced_motion":page.evaluate("matchMedia('(prefers-reduced-motion:reduce)').matches")})
    page.add_init_script("""window.__lcp=null;new PerformanceObserver(l=>{for(const e of l.getEntries())window.__lcp=e.startTime}).observe({type:'largest-contentful-paint',buffered:true});""")
    # Explicit throttled, cold-cache local lab runs; not production/device field evidence.
    cdp=page.context.new_cdp_session(page)
    cdp.send("Network.enable")
    cdp.send("Network.setCacheDisabled",{"cacheDisabled":True})
    cdp.send("Network.emulateNetworkConditions",{"offline":False,"latency":150,"downloadThroughput":200000,"uploadThroughput":93750,"connectionType":"cellular4g"})
    cdp.send("Emulation.setCPUThrottlingRate",{"rate":4})
    perf=[]
    for route,budget in [("/today/",300000),("/customers/",300000),("/collections/",300000),("/payments/",300000),("/reviews/",300000),("/reports/",300000),(borrower_url,100000),("/",500000),(consent_url,100000)]:
        if route==consent_url:
            cdp.send("Network.emulateNetworkConditions",{"offline":False,"latency":400,"downloadThroughput":93750,"uploadThroughput":31250,"connectionType":"cellular3g"})
        page.goto(route if route.startswith("http") else base+route,wait_until="load")
        page.wait_for_timeout(800)
        data=page.evaluate("""()=>{const n=performance.getEntriesByType('navigation')[0],rs=performance.getEntriesByType('resource');
          const all=[n,...rs],own=all.filter(r=>new URL(r.name).origin===location.origin),third=all.filter(r=>new URL(r.name).origin!==location.origin);return {load_ms:n.loadEventEnd-n.startTime,lcp_ms:window.__lcp,html_encoded:n.encodedBodySize,html_decoded:n.decodedBodySize,html_transfer:n.transferSize,first_party_encoded:own.reduce((s,r)=>s+r.encodedBodySize,0),first_party_decoded:own.reduce((s,r)=>s+r.decodedBodySize,0),third_party_encoded:third.reduce((s,r)=>s+r.encodedBodySize,0),third_party_decoded:third.reduce((s,r)=>s+r.decodedBodySize,0),first_party_transfer:own.reduce((s,r)=>s+r.transferSize,0),
          third_party_transfer:all.filter(r=>new URL(r.name).origin!==location.origin).reduce((s,r)=>s+r.transferSize,0),resource_count:rs.length}}""")
        data.update(route="/pay/<redacted>/" if route==borrower_url else "/consent/<redacted>/" if route==consent_url else route,budget_bytes=budget,network="3G: 400ms, 0.75Mbps down, 0.25Mbps up" if route==consent_url else "4G: 150ms, 1.6Mbps down, 0.75Mbps up")
        perf.append(data)
    cdp.send("Network.emulateNetworkConditions",{"offline":False,"latency":0,"downloadThroughput":-1,"uploadThroughput":-1})
    cdp.send("Emulation.setCPUThrottlingRate",{"rate":1})
    output={"browser":page.context.browser.version,"routes":results,"performance":perf,
        "dataset":{"customers":5001,"loans":5001,"instalments":5001,"request_records":1,"source":"5000-row browser import plus initial single-record browser journey"},
        "conditions":"Chromium, 360x850, reduced motion; local HTTP test server; cold cache; 150ms latency, 1.6 Mbps down, 0.75 Mbps up, 4x CPU slowdown. Encoded transferSize includes protocol estimates. Axe injected only for audits, not performance.",
        "manual_unverified":["native devices","screen readers","participants","browser-native zoom","full keyboard journey on every route"]}
    Path("evidence").mkdir(exist_ok=True)
    Path("evidence/browser-audit.json").write_text(json.dumps(output,indent=2))
    print("Browser audit:",len(results),"states;",sum(len(r["axe"]["violations"]) for r in results),"axe violations")
    assert not any(r["overflow"] or r["spacing_overflow"] or r["axe"]["violations"] for r in results),[(r["route"],r["width"],r["spacing_overflow"],r["axe"]["violations"]) for r in results if r["overflow"] or r["spacing_overflow"] or r["axe"]["violations"]]