// Real Chromium geometry with synthetic API replies; no credentials or model calls.
// shortcut: viewport emulation is not a physical keyboard test; add device checks before claiming device coverage.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const profile = await mkdtemp(path.join(process.env.OPENCODE_TMPDIR || tmpdir(), "vesuvius-browser-"));
const output = path.resolve("outputs/responsive");
const browserPath = process.env.BROWSER_EXECUTABLE || "chromium";
const viewports = [[280,653],[320,568],[375,667],[390,844],[430,932],[768,1024],[1024,768],[1440,900],[1920,1080],[2560,1440],[844,390],[390,300]];
const longWord = "unbroken".repeat(70);
const answer = `### What the evidence supports\n\nThis is a **synthetic layout fixture**, not a model response. Readable paragraphs and citations should fit inside a rounded assistant bubble. [1]\n\n- **Evidence:** wrap naturally across screen sizes.\n- **Uncertainty:** keep controls reachable while the conversation scrolls.\n- **Next step:** inspect source details without widening the page.\n\n${Array.from({length:5}, () => "A long research answer needs comfortable spacing, clear emphasis, and a stable reading width on both small phones and wide desktop screens.").join("\n\n")}\n\nA long token: ${longWord}\n\n\`\`\`javascript\nconst oversizedLine = "${"code".repeat(100)}";\n\`\`\`\n\nA final paragraph with a source. [1]`;
const reply = { mode: "live", rag: true, message: answer, sources: [{ id: "1", title: "Synthetic source with a long title " + longWord, url: "https://discord.com/channels/1/2/3", date: "2025-11-03" }, { id: "2", title: "Synthetic undated source" }] };
let app, browser, socket, fixture, releaseReply, signedIn = false, failNextChat = false, failNextLogout = false, holdNextReply = false, nextId = 0;
const pending = new Map();
const failures = [], results = [];

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  assert.ok(!result.exceptionDetails, "Browser evaluation failed");
  return result.result.value;
}
async function until(expression, label) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await evaluate(expression)) return;
    await delay(50);
  }
  throw new Error(`Browser readiness timed out: ${label}`);
}
async function fill(selector, text) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await cdp("Input.insertText", { text });
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
}
async function openLegalTab(base, href) {
  const point = await evaluate(`(() => { const e = document.querySelector('.privacy-footer a[href="${href}"]'); e.scrollIntoView({block:'nearest'}); const r = e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await cdp("Input.dispatchMouseEvent", {type:"mousePressed",...point,button:"left",clickCount:1});
  await cdp("Input.dispatchMouseEvent", {type:"mouseReleased",...point,button:"left",clickCount:1});
  let tab;
  for (let attempt = 0; attempt < 50; attempt++) {
    tab = (await cdp("Target.getTargets")).targetInfos.find(target => target.type === "page" && target.url === base + href);
    if (tab) break;
    await delay(100);
  }
  assert.ok(tab, "Legal link must open a separate tab");
  await cdp("Target.closeTarget", {targetId:tab.targetId});
}
function check(value, message) { if (!value) failures.push(message); }
function contrast(foreground, background) {
  const luminance = color => color.match(/[\d.]+/g).slice(0,3).map(Number).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126,.7152,.0722][index], 0);
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a,b) + .05) / (Math.min(a,b) + .05);
}
async function geometry(label, width, height, enlarged = false) {
  const metrics = await evaluate(`(() => {
    const box = selector => { const e = document.querySelector(selector); if (!e) return null; const r = e.getBoundingClientRect(), s = getComputedStyle(e); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,font:parseFloat(s.fontSize),radius:parseFloat(s.borderTopLeftRadius),background:s.backgroundColor,color:s.color,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,reachable:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}; };
    return {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,main:box('.main-content'),input:box('#question') || box('#invitation-code'),send:box('.send-button') || box('.invitation button'),conversation:box('.conversation'),assistant:box('.message.assistant'),user:box('.user-bubble'),code:box('.answer-text pre'),header:box('.site-header'),accessError:box('.composer-notices') || box('.access-error'),footer:box('.privacy-footer'),footerText:document.querySelector('.privacy-statement')?.textContent,sourceDate:document.querySelector('.source-list time')?.getAttribute('datetime'),unknownDate:document.querySelector('.source-list')?.textContent.includes('Date unavailable'),legalLinks:[...document.querySelectorAll('.privacy-footer nav a')].map(e => ({href:e.getAttribute('href'),width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}))};
  })()`);
  const prefix = `${width}x${height} ${label}`;
  check(metrics.documentWidth <= metrics.width + 1, `${prefix}: document overflows horizontally`);
  check(metrics.main.x >= -1 && metrics.main.right <= metrics.width + 1, `${prefix}: main content exceeds viewport`);
  check(metrics.footerText === "No tracking. No message logs on our servers.", `${prefix}: privacy footer missing or inaccurate`);
  check(metrics.legalLinks.length === 2 && metrics.legalLinks.every(link => ["/terms","/privacy"].includes(link.href) && link.width >= 44 && link.height >= 44), `${prefix}: legal links missing or smaller than 44px`);
  if (metrics.footer) {
    check(metrics.footer.y >= metrics.main.bottom - 1, `${prefix}: privacy footer overlaps the main content`);
    if (metrics.footer.bottom > metrics.height + 1) {
      const reachable = await evaluate(`(() => { const shell = document.querySelector('.app-shell'), footer = document.querySelector('.privacy-footer'), previous = shell.scrollTop; footer.scrollIntoView({block:'end'}); const r = footer.getBoundingClientRect(), visible = r.y >= 0 && r.bottom <= innerHeight + 1; shell.scrollTop = previous; return visible; })()`);
      check(reachable, `${prefix}: privacy footer cannot be reached by scrolling`);
    }
  }
  if (metrics.input) {
    check(metrics.input.font >= (enlarged ? 32 : 16) - .1, `${prefix}: input text too small`);
    check(metrics.input.x >= -1 && metrics.input.right <= metrics.width + 1, `${prefix}: input exceeds viewport width`);
    check(metrics.input.y >= metrics.header.bottom - 1 && metrics.input.bottom <= metrics.height + 1, `${prefix}: input is clipped vertically`);
    check(metrics.input.reachable, `${prefix}: input is covered or unreachable`);
  }
  if (metrics.send) {
    check(metrics.send.width >= 44 && metrics.send.height >= 44, `${prefix}: action target is smaller than 44px`);
    check(metrics.send.y >= -1 && metrics.send.bottom <= metrics.height + 1, `${prefix}: action is outside viewport`);
    check(metrics.send.reachable, `${prefix}: Send/Stop is covered or unreachable`);
  }
  if (metrics.accessError && metrics.input) check(metrics.accessError.bottom <= metrics.input.y || metrics.accessError.y >= metrics.input.bottom, `${prefix}: access error covers the input`);
  if (metrics.assistant) {
    check(metrics.sourceDate === "2025-11-03" && metrics.unknownDate, `${prefix}: source dates or unknown-date label missing`);
    check(metrics.assistant.radius >= 16, `${prefix}: assistant bubble is not rounded`);
    check(metrics.assistant.background !== "rgba(0, 0, 0, 0)", `${prefix}: assistant bubble is transparent`);
    check(metrics.assistant.right <= metrics.main.right + 1, `${prefix}: assistant bubble escapes column`);
    check(metrics.conversation.height >= 24, `${prefix}: conversation has no usable scroll area`);
    check(metrics.conversation.scrollHeight > metrics.conversation.clientHeight, `${prefix}: long conversation is not independently scrollable`);
    check(metrics.conversation.bottom <= metrics.input.y + 1, `${prefix}: conversation overlaps composer`);
    const channels = metrics.user.background.match(/[\d.]+/g).slice(0,3).map(Number);
    check(channels[2] >= channels[0] + 25, `${prefix}: user bubble is not muted blue`);
    check(metrics.user.radius >= 16, `${prefix}: user bubble is not rounded`);
    check(contrast(metrics.user.color, metrics.user.background) >= 4.5, `${prefix}: user text contrast below 4.5:1`);
    check(metrics.code.scrollWidth > metrics.code.clientWidth && metrics.code.right <= metrics.assistant.right + 1, `${prefix}: code does not scroll inside its bubble`);
    check(metrics.assistant.font >= (enlarged ? 32 : 16) - .1 && metrics.assistant.font <= (enlarged ? 38 : 19) + .1, `${prefix}: body text outside fluid font range`);
  }
  results.push({ viewport:[width,height], state:label, font:metrics.input?.font, horizontalOverflow:metrics.documentWidth > metrics.width + 1 });
}

try {
  await mkdir(output, { recursive:true });
  let target = process.argv[2] ? new URL(process.argv[2]) : null;
  if (!target) {
    await cp("public",".next/standalone/public",{recursive:true});
    await cp(".next/static",".next/standalone/.next/static",{recursive:true});
    const probe = createServer(); await new Promise(resolve => probe.listen(0,"127.0.0.1",resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    app = spawn(process.execPath, [".next/standalone/server.js"], { env:{...process.env,NODE_ENV:"production",CHAT_ENV:"production",HOSTNAME:"127.0.0.1",PORT:String(port),APP_ORIGIN:"https://chat.layout.invalid",OPENROUTER_API_KEY:"offline-dummy",OPENROUTER_MODEL:"offline/fixed-model",NEXT_TELEMETRY_DISABLED:"1"},stdio:"ignore" });
    target = new URL(`http://127.0.0.1:${port}`);
  }
  assert.ok(["http:","https:"].includes(target.protocol) && !target.username && !target.password);
  fixture = createServer((request,response) => {
    const route = new URL(request.url,"http://fixture.invalid").pathname;
    if (route.startsWith("/api/")) {
      let status = 200, body = {};
      if (route === "/api/session") {
        if (request.method === "DELETE" && failNextLogout) { failNextLogout = false; status = 503; body = {error:"Could not complete the request. Please try again in a moment."}; }
        else { if (request.method === "POST") signedIn = true; if (request.method === "DELETE") signedIn = false; status = signedIn || request.method === "DELETE" ? 200 : 401; body = {authenticated:signedIn}; }
      }
      else if (route === "/api/status") body = {mode:"live",rag:true};
      else if (route === "/api/chat") { status = failNextChat ? 503 : 200; body = failNextChat ? {error:"Synthetic connection issue. Please retry."} : reply; failNextChat = false; }
      else status = 404;
      request.resume();
      const finish = () => response.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store"}).end(JSON.stringify(body));
      if (route === "/api/chat" && holdNextReply) { holdNextReply = false; releaseReply = finish; }
      else finish();
      return;
    }
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const upstream = send(new URL(request.url,target),{method:request.method,headers:{...request.headers,host:target.protocol === "https:" ? target.host : "chat.layout.invalid","x-forwarded-proto":"https","x-real-ip":"192.0.2.1",cookie:""}},incoming => { response.writeHead(incoming.statusCode,incoming.headers); incoming.pipe(response); });
    upstream.on("error",() => { if (!response.headersSent) response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  await new Promise(resolve => fixture.listen(0,"127.0.0.1",resolve));
  const base = `http://127.0.0.1:${fixture.address().port}`;
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(base).catch(() => null);
    if (response?.ok) break;
    assert.ok(attempt < 150,"Compiled application did not start"); await delay(100);
  }
  browser = spawn(browserPath,["--headless=new","--disable-gpu","--disable-background-networking","--disable-component-update","--disable-sync","--no-first-run","--no-default-browser-check","--remote-debugging-address=127.0.0.1","--remote-debugging-port=0",`--user-data-dir=${profile}`,"about:blank"],{stdio:"ignore"});
  let port;
  for (let attempt = 0; ; attempt++) {
    port = await readFile(path.join(profile,"DevToolsActivePort"),"utf8").catch(() => "");
    if (port) break;
    assert.ok(attempt < 150 && browser.exitCode === null,"Owned Chromium browser did not start"); await delay(100);
  }
  const targets = await (await fetch(`http://127.0.0.1:${port.split("\n")[0]}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === "page").webSocketDebuggerUrl); await once(socket,"open");
  socket.addEventListener("message",event => {
    const message = JSON.parse(event.data), task = pending.get(message.id);
    if (task) { pending.delete(message.id); clearTimeout(task.timer); if (message.error) task.reject(new Error(message.error.message)); else task.resolve(message.result); }
  });
  await cdp("Page.enable"); await cdp("Runtime.enable");
  await cdp("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
  for (const [width,height] of viewports) {
    await cdp("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
    signedIn = false;
    await cdp("Page.navigate",{url:base});
    await until("!!document.querySelector('#invitation-code')","invitation");
    check(!await evaluate("document.querySelector('.invitation').textContent.includes('Sign in with your invitation to explore the Vesuvius corpus.')"), "Removed invitation introduction is still visible");
    await evaluate("document.fonts.ready");
    await evaluate("document.querySelector('.invitation form').scrollIntoView({block:'nearest'})");
    check(await evaluate("(() => { const input = document.querySelector('#invitation-code').getBoundingClientRect(), notice = document.querySelector('#sign-in-terms').getBoundingClientRect(), button = document.querySelector('.invitation button').getBoundingClientRect(); return input.bottom <= notice.top + 1 && notice.bottom <= button.top + 1; })()"), "Sign-in notice must appear between the input and button");
    await geometry("invitation",width,height);
    await fill("#invitation-code","synthetic-layout-invitation");
    await evaluate("document.querySelector('.invitation form').requestSubmit()");
    await until("!!document.querySelector('#question')","welcome composer");
    await geometry("welcome",width,height);
    await fill("#question","A synthetic research question with enough text to exercise a responsive blue bubble.");
    holdNextReply = true;
    await evaluate("document.querySelector('.composer').requestSubmit()");
    await until("!!document.querySelector('[aria-label=\"Stop response\"]') && !!document.querySelector('.thinking')","pending response");
    if (width === 390 && height === 844) {
      await openLegalTab(base,"/terms");
      check(await evaluate("!!document.querySelector('[aria-label=\"Stop response\"]') && document.querySelectorAll('.message.user').length === 1"), "Reading terms discarded or cancelled the pending chat");
    }
    await geometry("waiting",width,height);
    assert.equal(typeof releaseReply,"function"); releaseReply(); releaseReply = null;
    await until("!!document.querySelector('.message.assistant')","synthetic response");
    await evaluate("document.querySelector('.sources').open = true");
    if ([390,768,1440].includes(width) && height > 400) {
      await evaluate("document.querySelector('.conversation').scrollTop = 0");
      const image = await cdp("Page.captureScreenshot",{format:"png"});
      await writeFile(path.join(output,`${width}x${height}.png`),Buffer.from(image.data,"base64"));
    }
    await fill("#question",Array.from({length:6},() => "A multiline draft wraps naturally without hiding the Send button.").join("\n"));
    if (width === 390 && height === 844) {
      const draft = await evaluate("document.querySelector('#question').value");
      await openLegalTab(base,"/privacy");
      check(await evaluate(`document.querySelector('#question').value === ${JSON.stringify(draft)} && document.querySelectorAll('.message.assistant').length === 1`), "Reading privacy notice discarded the draft or conversation");
    }
    await geometry("conversation",width,height);
    failNextChat = true;
    await evaluate("document.querySelector('.composer').requestSubmit()");
    await until("!!document.querySelector('.error-message')","synthetic error notice");
    await geometry("conversation-error",width,height);
    failNextLogout = true;
    await evaluate("document.querySelector('.logout-button').click()");
    await until("!!document.querySelector('.access-error')","synthetic sign-out notice");
    await geometry("sign-out-error",width,height);
  }
  await cdp("Emulation.setDeviceMetricsOverride",{width:1024,height:768,deviceScaleFactor:1,mobile:false});
  await evaluate("document.documentElement.style.fontSize='200%'");
  await evaluate("window.dispatchEvent(new Event('resize')); new Promise(resolve => requestAnimationFrame(resolve))");
  await geometry("200-percent-text",1024,768,true);
  signedIn = false;
  await cdp("Page.navigate",{url:base});
  await until("!!document.querySelector('#invitation-code')","enlarged invitation");
  await evaluate("document.documentElement.style.fontSize='200%'");
  await evaluate("document.querySelector('.invitation form').scrollIntoView({block:'nearest'})");
  await geometry("200-percent-invitation",1024,768,true);
  for (const [width,height] of [[280,300],[320,568],[390,300],[844,390]]) {
    await cdp("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
    signedIn = true;
    await cdp("Page.navigate",{url:base});
    await until("!!document.querySelector('#question')","enlarged chat");
    await evaluate("document.fonts.ready.then(() => { document.documentElement.style.fontSize='200%'; window.dispatchEvent(new Event('resize')); })");
    await fill("#question","Synthetic narrow-screen error regression.");
    holdNextReply = true;
    await evaluate("document.querySelector('.composer').requestSubmit()");
    await until("!!document.querySelector('[aria-label=\"Stop response\"]')","enlarged pending response");
    failNextLogout = true;
    await evaluate("document.querySelector('.logout-button').click()");
    await until("!!document.querySelector('.access-error')","enlarged sign-out error");
    await geometry("200-percent-sign-out-stop",width,height,true);
    assert.equal(typeof releaseReply,"function"); releaseReply(); releaseReply = null;
    await until("!!document.querySelector('.message.assistant')","enlarged response");
    await evaluate("document.querySelector('.sources').open = true");
    await fill("#question","A multiline draft\nwith enlarged text\nstill leaves Send reachable.");
    await geometry("200-percent-sign-out-send",width,height,true);
    check(await evaluate(`(() => { const e = document.querySelector('.composer-notices'); if (!e) return false; e.scrollTop = e.scrollHeight; return e.scrollHeight <= e.clientHeight || e.scrollTop > 0; })()`), `${width}x${height}: enlarged notice text cannot be scrolled`);
    if (width === 280) {
      await evaluate("document.querySelector('.composer-notices').scrollTop = 0");
      const image = await cdp("Page.captureScreenshot",{format:"png"});
      await writeFile(path.join(output,"280x300-200-percent.png"),Buffer.from(image.data,"base64"));
    }
    signedIn = false;
    await cdp("Page.navigate",{url:base});
    await until("!!document.querySelector('#invitation-code')","narrow enlarged invitation");
    await evaluate("document.fonts.ready.then(() => { document.documentElement.style.fontSize='200%'; })");
    for (const selector of ['#invitation-code','.invitation button']) {
      const reachable = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)); })()`);
      check(reachable, `${width}x${height}: enlarged invitation ${selector} cannot be reached by scrolling`);
    }
    check(await evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), `${width}x${height}: enlarged invitation overflows horizontally`);
    results.push({viewport:[width,height],state:"200-percent-scrollable-invitation"});
  }
  for (const route of ["/terms","/privacy"]) {
    for (const [width,height] of [[280,653],[390,844],[1024,768]]) {
      for (const percent of [100,200]) {
        await cdp("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
        await cdp("Page.navigate",{url:base+route});
        await until("!!document.querySelector('.legal-content h1')","public legal page");
        await evaluate(`document.fonts.ready.then(() => { document.documentElement.style.fontSize='${percent}%'; })`);
        const page = await evaluate(`({title:document.querySelector('h1').textContent,width:innerWidth,scrollWidth:document.documentElement.scrollWidth,font:parseFloat(getComputedStyle(document.querySelector('.legal-content')).fontSize)})`);
        const label = `${width}x${height} ${route} ${percent}%`;
        check(page.title === (route === "/terms" ? "Terms of Use" : "Privacy Notice"), `${label}: wrong legal heading`);
        check(page.scrollWidth <= page.width + 1, `${label}: legal page overflows horizontally`);
        check(page.font >= (percent === 200 ? 32 : 16) - .1, `${label}: legal text too small`);
        for (const href of ["/terms","/privacy"]) {
          const reachable = await evaluate(`(() => { const e = document.querySelector('.privacy-footer a[href="${href}"]'); e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)); })()`);
          check(reachable, `${label}: legal footer link is unreachable`);
        }
        results.push({viewport:[width,height],state:`${route}-${percent}-percent`,horizontalOverflow:page.scrollWidth > page.width + 1});
      }
    }
  }
  await writeFile(path.join(output,"results.json"),JSON.stringify({results,failures},null,2)+"\n");
  assert.equal(failures.length,0,failures.slice(0,25).join("\n"));
  console.log(JSON.stringify({ok:true,viewports:new Set(results.map(row => row.viewport.join('x'))).size,states:results.length,realModelRequests:0,screenshots:output},null,2));
} finally {
  socket?.close();
  for (const child of [browser,app]) if (child && child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([once(child,"exit"),delay(5000)]); if (child.exitCode === null) child.kill("SIGKILL"); }
  if (fixture) { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); }
  await rm(profile,{recursive:true,force:true});
}
