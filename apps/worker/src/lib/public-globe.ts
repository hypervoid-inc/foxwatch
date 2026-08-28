/** Browser globe. No interpolations — concatenated into the public page script. */
export const GLOBE_CLIENT_SCRIPT = `(function(){
  var stage=document.getElementById("globe-stage");
  if (!stage) return;
  window.__fwRevealGlobe=function(){
    var el=document.getElementById("globe-stage");
    if (!el || el.hidden || el.classList.contains("is-in") || el.classList.contains("is-ready")) return;
    el.classList.add("is-in");
    function finish(e){
      if (e && e.target!==el) return;
      if (e && e.animationName && e.animationName!=="globe-focus" && e.animationName!=="globe-arrive-fade") return;
      el.removeEventListener("animationend", finish);
      el.classList.add("is-ready");
      el.classList.remove("is-in");
    }
    el.addEventListener("animationend", finish);
    setTimeout(function(){ finish(); }, 1000);
  };
  var canvas, ctx, labels, lctx, dpr=1, w=0, h=0, cx=0, cy=0, radius=0;
  var yaw=0.35, pitch=0.22, vYaw=0, vPitch=0, raf=0, dragging=false, moved=false;
  var lastX=0, lastY=0, lastT=0, pointerId=null, lastTick=0;
  var land=[], nodes=[], arcs=[], you=null, youTo=null, hot=null, looking=false, aimedYou=false;
  var reduce=false, spinning=false, spinT=0, idleTimer=0;
  var mq=window.matchMedia("(min-width: 1100px) and (hover: hover) and (pointer: fine)");
  var reduceMq=window.matchMedia("(prefers-reduced-motion: reduce)");
  var IDLE_MS=1000;
  var SPIN=0.000062;
  var SPIN_IN_MS=1200;
  var SPIN_OUT_MS=420;
  var HOP_LIFT=0.16;
  var HOP_STEPS=40;
  function desktop(){ return mq.matches; }
  var THEME={
    light:{"--bg":"#efece6","--ink":"#3a3732","--muted":"#6d6860","--line":"#ddd8ce","--card":"#f7f4ee","--hover":"#e8e4dc","--ok":"#2f8f73","--warn":"#c4841d","--bad":"#c75c6e","--empty":"#e4dfd6"},
    dark:{"--bg":"#2c2b28","--ink":"#e4e0d8","--muted":"#a8a39a","--line":"#4a4842","--card":"#363530","--hover":"#3f3e39","--ok":"#5eb89a","--warn":"#d4a04a","--bad":"#e07a8a","--empty":"#4a4842"}
  };
  function themeName(){
    var t=document.documentElement.getAttribute("data-theme");
    if (t==="dark"||t==="light") return t;
    return matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";
  }
  function token(name){ return THEME[themeName()][name]||getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function clamp(n, lo, hi){ return Math.min(hi, Math.max(lo, n)); }
  function vec(lat, lng){
    var phi=lat*Math.PI/180, lam=lng*Math.PI/180, c=Math.cos(phi);
    return { x:c*Math.sin(lam), y:Math.sin(phi), z:c*Math.cos(lam) };
  }
  function rot(v){
    var cy=Math.cos(yaw), sy=Math.sin(yaw);
    var x1=v.x*cy+v.z*sy, z1=-v.x*sy+v.z*cy;
    var cp=Math.cos(pitch), sp=Math.sin(pitch);
    return { x:x1, y:v.y*cp-z1*sp, z:v.y*sp+z1*cp };
  }
  function project(v){
    var r=rot(v);
    return { x:cx+r.x*radius, y:cy-r.y*radius, z:r.z };
  }
  function dot(a,b){ return a.x*b.x+a.y*b.y+a.z*b.z; }
  function slerp(a,b,t){
    var d=clamp(dot(a,b),-1,1), omega=Math.acos(d);
    if (omega<1e-6) return a;
    var s=Math.sin(omega);
    var k0=Math.sin((1-t)*omega)/s, k1=Math.sin(t*omega)/s;
    return { x:a.x*k0+b.x*k1, y:a.y*k0+b.y*k1, z:a.z*k0+b.z*k1 };
  }
  function hop(a,b,t){
    var p=slerp(a,b,t), alt=1+HOP_LIFT*Math.sin(Math.PI*t);
    return { x:p.x*alt, y:p.y*alt, z:p.z*alt };
  }
  function parseColor(s){
    s=(s||"").trim();
    if (s.charAt(0)==="#"){
      var h=s.slice(1);
      if (h.length===3) h=h.charAt(0)+h.charAt(0)+h.charAt(1)+h.charAt(1)+h.charAt(2)+h.charAt(2);
      if (h.length>=6) return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
    }
    return [80,78,74];
  }
  function mixHex(a, b, t){
    var A=parseColor(a), B=parseColor(b);
    t=clamp(t,0,1);
    return "rgb("+Math.round(A[0]+(B[0]-A[0])*t)+","+Math.round(A[1]+(B[1]-A[1])*t)+","+Math.round(A[2]+(B[2]-A[2])*t)+")";
  }
  function readLand(){
    var el=document.getElementById("globe-land");
    if (!el || !el.textContent) return [];
    try { return JSON.parse(el.textContent); } catch (e) { return []; }
  }
  function kindColor(kind){
    if (kind==="bad") return token("--bad");
    if (kind==="warn") return token("--warn");
    if (kind==="empty") return token("--muted");
    return token("--ok");
  }
  function arcTint(a, b){
    if (a.kind==="bad" || b.kind==="bad") return token("--bad");
    if (a.kind==="warn" || b.kind==="warn") return token("--warn");
    return token("--ok");
  }
  function readScene(){
    nodes=[]; arcs=[];
    var root=document.getElementById("live-mesh");
    if (!root || root.hasAttribute("hidden")) return false;
    var buttons=root.querySelectorAll(".mesh-node");
    for (var i=0;i<buttons.length;i++){
      var n=buttons[i], lat=+n.getAttribute("data-lat"), lng=+n.getAttribute("data-lng");
      if (!isFinite(lat) || !isFinite(lng)) continue;
      var kind="ok";
      if (n.classList.contains("bad")) kind="bad";
      else if (n.classList.contains("warn")) kind="warn";
      else if (n.classList.contains("empty")) kind="empty";
      nodes.push({
        id:n.getAttribute("data-region"),
        lat:lat, lng:lng, kind:kind, v:vec(lat,lng),
        label:n.getAttribute("data-label")||"",
        read:n.getAttribute("data-read")||""
      });
    }
    var paths=root.querySelectorAll(".mesh-arc");
    for (var j=0;j<paths.length;j++){
      var a=paths[j].getAttribute("data-a"), b=paths[j].getAttribute("data-b");
      var na=null, nb=null;
      for (var k=0;k<nodes.length;k++){
        if (nodes[k].id===a) na=nodes[k];
        if (nodes[k].id===b) nb=nodes[k];
      }
      if (na && nb) arcs.push({ a:na, b:nb });
    }
    var here=window.__fwHere;
    you=here && here.lat!=null && here.lng!=null ? { lat:here.lat, lng:here.lng, v:vec(here.lat, here.lng), city:here.city||here.colo||"" } : null;
    youTo=null;
    if (you){
      var best=null, bestD=1e9, di, dd;
      for (di=0; di<nodes.length; di++){
        dd=1-dot(you.v, nodes[di].v);
        if (dd<bestD){ bestD=dd; best=nodes[di]; }
      }
      youTo=best;
    }
    if (you && !aimedYou){
      yaw=-you.lng*Math.PI/180;
      pitch=clamp(you.lat*Math.PI/180*0.55, -0.95, 0.95);
      aimedYou=true;
      looking=true;
    } else if (!looking && nodes[0]){
      var lat0=nodes.reduce(function(s,n){ return s+n.lat; },0)/nodes.length;
      var lng0=nodes.reduce(function(s,n){ return s+n.lng; },0)/nodes.length;
      yaw=-lng0*Math.PI/180;
      pitch=clamp(lat0*Math.PI/180*0.55, -0.95, 0.95);
      looking=true;
    }
    return nodes.length>0;
  }
  function size(){
    if (!canvas) return;
    w=Math.max(1, Math.round(document.documentElement.clientWidth||window.innerWidth));
    h=Math.max(1, Math.round(document.documentElement.clientHeight||window.innerHeight));
    dpr=Math.min(2, window.devicePixelRatio||1);
    canvas.width=Math.round(w*dpr);
    canvas.height=Math.round(h*dpr);
    canvas.style.width=w+"px";
    canvas.style.height=h+"px";
    ctx.setTransform(dpr,0,0,dpr,0,0);
    if (labels && lctx){
      labels.width=Math.round(w*dpr);
      labels.height=Math.round(h*dpr);
      labels.style.width=w+"px";
      labels.style.height=h+"px";
      lctx.setTransform(dpr,0,0,dpr,0,0);
    }
    var rem=parseFloat(getComputedStyle(document.documentElement).fontSize)||16;
    var pad=24;
    var envelope=1+HOP_LIFT;
    var t1280=(w-1100)/180, t1440=(w-1280)/160;
    function mix(a,b,t){ t=t<0?0:t>1?1:t; return a+(b-a)*t; }
    var yBias=mix(0.36,0.4,t1280);
    var widthFrac=mix(0.4,mix(0.43,0.46,t1440),t1280);
    radius=Math.min(h*mix(0.7,0.78,t1280), rem*mix(32,38,t1280))*0.48;
    cy=h*yBias;
    var maxR=Math.min((w*widthFrac)/envelope, Math.max(8,(cy-pad)/envelope), Math.max(8,(h-pad-cy)/envelope));
    if (radius>maxR) radius=maxR;
    if (!(radius>0) || !isFinite(radius)) radius=80;
    var minCy=pad+radius*envelope, maxCy=h-pad-radius*envelope;
    if (minCy<=maxCy) cy=Math.min(maxCy, Math.max(minCy, cy));
    else cy=h/2;
    cx=w-pad-radius*envelope;
    if (cx+radius*envelope>w-pad) cx=w-pad-radius*envelope;
    if (cx-radius*envelope<pad) radius=Math.min(radius, Math.max(8,(cx-pad)/envelope));
    syncGutter(true);
  }
  function syncGutter(on){
    if (!on){
      document.documentElement.style.removeProperty("--globe-left");
      document.documentElement.style.removeProperty("--globe-cx");
      document.documentElement.style.removeProperty("--globe-cy");
      return;
    }
    document.documentElement.style.setProperty("--globe-left", Math.round(cx-radius)+"px");
    document.documentElement.style.setProperty("--globe-cx", Math.round(cx)+"px");
    document.documentElement.style.setProperty("--globe-cy", Math.round(cy)+"px");
  }
  function nearGlobe(e){
    var rect=canvas.getBoundingClientRect();
    var x=e.clientX-rect.left, y=e.clientY-rect.top;
    var dx=x-cx, dy=y-cy, lim=radius*1.28;
    return dx*dx+dy*dy<=lim*lim;
  }
  function spinEase(t){ t=t<0?0:t>1?1:t; return t*t*(3-2*t); }
  function stepSpin(dt){
    var target=spinning?1:0;
    if (spinT===target) return;
    var dur=target>spinT?SPIN_IN_MS:SPIN_OUT_MS;
    spinT+=(target>spinT?1:-1)*(dt/dur);
    if (spinT<0) spinT=0;
    if (spinT>1) spinT=1;
    if (Math.abs(spinT-target)<0.0005) spinT=target;
  }
  function pauseSpin(){
    spinning=false;
    if (idleTimer){ clearTimeout(idleTimer); idleTimer=0; }
  }
  function bumpIdle(){
    if (idleTimer){ clearTimeout(idleTimer); idleTimer=0; }
    if (reduce || !canvas){ spinning=false; if (reduce) spinT=0; return; }
    idleTimer=setTimeout(function(){
      idleTimer=0;
      if (reduce || dragging || !canvas) return;
      spinning=true;
      if (!raf){ lastTick=0; raf=requestAnimationFrame(tick); }
    }, IDLE_MS);
  }
  function sampleHop(a, b){
    var pts=[], j;
    for (j=0;j<=HOP_STEPS;j++) pts.push(project(hop(a, b, j/HOP_STEPS)));
    return pts;
  }
  function strokeHop(pts, width, color){
    if (pts.length<2) return;
    ctx.lineWidth=width;
    ctx.strokeStyle=color;
    ctx.globalAlpha=0.88;
    ctx.lineCap="round";
    ctx.lineJoin="round";
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    var i;
    for (i=1;i<pts.length;i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.globalAlpha=1;
  }
  function clipDisk(fn){
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI*2);
    ctx.clip();
    fn();
    ctx.restore();
  }
  function tri(a, b, c, isLand){
    var pa=project(a), pb=project(b), pc=project(c);
    if (pa.z<0.02 && pb.z<0.02 && pc.z<0.02) return;
    var mx=(a.x+b.x+c.x)/3, my=(a.y+b.y+c.y)/3, mz=(a.z+b.z+c.z)/3;
    var rm=rot({ x:mx, y:my, z:mz });
    if (rm.z<0.02) return;
    var len=Math.hypot(rm.x, rm.y, rm.z)||1;
    var sh=clamp(0.22+0.78*((-0.38*rm.x+0.52*rm.y+0.76*rm.z)/len), 0, 1);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.lineTo(pc.x, pc.y);
    ctx.closePath();
    ctx.fillStyle=isLand ? mixHex(token("--empty"), token("--muted"), sh*0.7) : mixHex(token("--bg"), token("--hover"), 0.12+0.88*sh);
    ctx.fill();
    ctx.globalAlpha=isLand?0.28:0.32;
    ctx.strokeStyle=token("--line");
    ctx.lineWidth=isLand?0.55:0.7;
    ctx.stroke();
    ctx.globalAlpha=1;
  }
  function drawFacets(){
    var dLat=10, dLng=12, lat, lng, a, b, c, d;
    for (lat=-80; lat<80; lat+=dLat){
      for (lng=-180; lng<180; lng+=dLng){
        a=vec(lat, lng); b=vec(lat, lng+dLng); c=vec(lat+dLat, lng+dLng); d=vec(lat+dLat, lng);
        tri(a,b,c,false); tri(a,c,d,false);
      }
    }
    for (lng=-180; lng<180; lng+=dLng){
      a=vec(80, lng); b=vec(80, lng+dLng); c=vec(90, lng);
      tri(a,b,c,false);
      a=vec(-90, lng); b=vec(-80, lng); c=vec(-80, lng+dLng);
      tri(a,b,c,false);
    }
  }
  function drawGraticule(){
    var lat, lng, p, started;
    ctx.lineWidth=0.65;
    ctx.strokeStyle=token("--line");
    ctx.globalAlpha=0.22;
    for (lng=-180; lng<180; lng+=20){
      ctx.beginPath();
      started=false;
      for (lat=-80; lat<=80; lat+=6){
        p=project(vec(lat, lng));
        if (p.z<0.04){ started=false; continue; }
        if (!started){ ctx.moveTo(p.x,p.y); started=true; }
        else ctx.lineTo(p.x,p.y);
      }
      ctx.stroke();
    }
    for (lat=-60; lat<=60; lat+=20){
      ctx.beginPath();
      started=false;
      for (lng=-180; lng<=180; lng+=6){
        p=project(vec(lat, lng));
        if (p.z<0.04){ started=false; continue; }
        if (!started){ ctx.moveTo(p.x,p.y); started=true; }
        else ctx.lineTo(p.x,p.y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha=1;
  }
  function drawSheen(){
    var g=ctx.createRadialGradient(cx-radius*0.32, cy-radius*0.4, radius*0.02, cx-radius*0.18, cy-radius*0.22, radius*0.82);
    g.addColorStop(0, "rgba(255,255,255,0.16)");
    g.addColorStop(0.28, "rgba(255,255,255,0.05)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI*2);
    ctx.fillStyle=g;
    ctx.fill();
  }
  function landPts(ring, back){
    var cut=back?0.04:-0.02, pts=[], i, n, a, b, aShow, bShow, t;
    for (i=0;i<ring.length;i++){
      n=ring[(i+1)%ring.length];
      a=project(vec(ring[i][1], ring[i][0]));
      b=project(vec(n[1], n[0]));
      aShow=back ? a.z<=cut : a.z>cut;
      bShow=back ? b.z<=cut : b.z>cut;
      if (aShow) pts.push(a);
      if (aShow!==bShow && a.z!==b.z){
        t=(cut-a.z)/(b.z-a.z);
        if (t>0 && t<1) pts.push({ x:a.x+(b.x-a.x)*t, y:a.y+(b.y-a.y)*t, z:cut });
      }
    }
    return pts;
  }
  function fillLand(ring, back){
    var pts=landPts(ring, back), i;
    if (pts.length<3) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (i=1;i<pts.length;i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.globalAlpha=back?0.22:0.94;
    ctx.fillStyle=token("--empty");
    ctx.fill();
    ctx.globalAlpha=back?0.18:0.62;
    ctx.strokeStyle=token("--line");
    ctx.lineWidth=1.05;
    ctx.stroke();
    ctx.globalAlpha=1;
  }
  function drawLand(){
    var i;
    for (i=0;i<land.length;i++) fillLand(land[i], true);
    for (i=0;i<land.length;i++) fillLand(land[i], false);
  }
  function drawArcs(){
    var i, pts, on;
    for (i=0;i<arcs.length;i++){
      pts=sampleHop(arcs[i].a.v, arcs[i].b.v);
      on=hot && (arcs[i].a.id===hot || arcs[i].b.id===hot);
      strokeHop(pts, on?2.2:1.35, on?token("--ink"):arcTint(arcs[i].a, arcs[i].b));
    }
  }
  function drawYouHop(){
    if (!you || !youTo) return;
    ctx.save();
    ctx.setLineDash([3.5, 4.5]);
    strokeHop(sampleHop(you.v, youTo.v), 1.2, token("--ink"));
    ctx.restore();
  }
  function drawNodes(){
    var i, p, n, r;
    for (i=0;i<nodes.length;i++){
      n=nodes[i];
      p=project(n.v);
      if (p.z<0.08) continue;
      r=n.id===hot?6:4.2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r+3.2, 0, Math.PI*2);
      ctx.fillStyle=token("--card");
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI*2);
      ctx.fillStyle=kindColor(n.kind);
      ctx.fill();
    }
    if (you){
      p=project(you.v);
      if (p.z>=0.08){
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(Math.PI/4);
        ctx.fillStyle=token("--ink");
        ctx.fillRect(-3.2, -3.2, 6.4, 6.4);
        ctx.restore();
      }
    }
  }
  function roundRect(c, x, y, rw, rh, rad){
    var rr=Math.min(rad, rw/2, rh/2);
    c.beginPath();
    c.moveTo(x+rr, y);
    c.arcTo(x+rw, y, x+rw, y+rh, rr);
    c.arcTo(x+rw, y+rh, x, y+rh, rr);
    c.arcTo(x, y+rh, x, y, rr);
    c.arcTo(x, y, x+rw, y, rr);
    c.closePath();
  }
  function drawTag(px, py, title, sub, accent){
    var c=lctx||ctx;
    if (!c) return;
    var ox=px-cx, oy=py-cy, len=Math.hypot(ox, oy)||1;
    ox/=len; oy/=len;
    c.font="650 11px ui-sans-serif, system-ui, sans-serif";
    var w1=c.measureText(title).width;
    c.font="500 10px ui-sans-serif, system-ui, sans-serif";
    var w2=sub?c.measureText(sub).width:0;
    var tw=Math.min(220, Math.max(w1, w2)+16);
    var th=sub?34:22;
    var left=ox<0.12;
    var bx=px+ox*16-(left?tw:0);
    var by=py+oy*16-th/2;
    bx=clamp(bx, 8, w-tw-8);
    by=clamp(by, 8, h-th-8);
    c.beginPath();
    c.moveTo(px, py);
    c.lineTo(left?bx+tw:bx, by+th/2);
    c.strokeStyle=token("--line");
    c.lineWidth=1;
    c.globalAlpha=0.55;
    c.stroke();
    c.globalAlpha=1;
    roundRect(c, bx, by, tw, th, 8);
    c.fillStyle=token("--card");
    c.fill();
    c.strokeStyle=token("--line");
    c.lineWidth=1;
    c.stroke();
    c.fillStyle=token("--ink");
    c.font="650 11px ui-sans-serif, system-ui, sans-serif";
    c.fillText(title, bx+8, by+(sub?14:14));
    if (sub){
      c.fillStyle=token("--muted");
      c.font="500 10px ui-sans-serif, system-ui, sans-serif";
      c.fillText(sub, bx+8, by+27);
    }
  }
  function splitRead(n){
    var read=n.read||"", label=n.label||"", rest;
    if (!read || read===label) return "";
    if (label && read.indexOf(label)===0){
      rest=read.slice(label.length);
      if (rest.indexOf(" · ")===0) rest=rest.slice(3);
      return rest;
    }
    return read;
  }
  function drawLabels(){
    var i, n, p, sub;
    if (lctx) lctx.clearRect(0,0,w,h);
    for (i=0;i<nodes.length;i++){
      n=nodes[i];
      if (hot && n.id===hot) continue;
      if (n.kind!=="bad" && n.kind!=="warn") continue;
      p=project(n.v);
      if (p.z<0.28) continue;
      drawTag(p.x, p.y, n.label||n.id, "", kindColor(n.kind));
    }
    if (you && (!hot || hot!=="you")){
      p=project(you.v);
      if (p.z>=0.28){
        var youSub=you.city||"";
        if (youTo) youSub=youSub?youSub+" · "+youTo.label:youTo.label;
        drawTag(p.x, p.y, "You", youSub, token("--ink"));
      }
    }
    if (hot==="you" && you){
      p=project(you.v);
      if (p.z>=0.08) drawTag(p.x, p.y, "You", you.city?you.city+(youTo?" · nearest "+youTo.label:""):"", token("--ink"));
    } else if (hot){
      for (i=0;i<nodes.length;i++){
        if (nodes[i].id!==hot) continue;
        p=project(nodes[i].v);
        if (p.z<0.08) break;
        sub=splitRead(nodes[i]);
        drawTag(p.x, p.y, nodes[i].label||nodes[i].id, sub, kindColor(nodes[i].kind));
        break;
      }
    }
  }
  function paint(){
    if (window.__fwGpuGlobe){ unmount(); return; }
    if (!ctx || !w) return;
    ctx.clearRect(0,0,w,h);
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI*2);
    ctx.fillStyle=token("--hover");
    ctx.fill();
    clipDisk(function(){
      drawFacets();
      drawGraticule();
      drawLand();
      drawSheen();
      var g=ctx.createRadialGradient(cx-radius*0.25, cy-radius*0.3, radius*0.08, cx, cy, radius);
      g.addColorStop(0, "rgba(255,255,255,0)");
      g.addColorStop(1, token("--bg"));
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI*2);
      ctx.globalAlpha=themeName()==="dark"?0.22:0.1;
      ctx.fillStyle=g;
      ctx.fill();
      ctx.globalAlpha=1;
    });
    drawArcs();
    drawYouHop();
    drawNodes();
    drawLabels();
    if (typeof window.__fwRevealGlobe==="function") window.__fwRevealGlobe();
  }
  function pickAt(clientX, clientY){
    var rect=canvas.getBoundingClientRect();
    var x=clientX-rect.left, y=clientY-rect.top;
    var best=null, bestD=40*40, i, p, d;
    for (i=0;i<nodes.length;i++){
      p=project(nodes[i].v);
      if (p.z<0.1) continue;
      d=(p.x-x)*(p.x-x)+(p.y-y)*(p.y-y);
      if (d<bestD){ bestD=d; best=nodes[i].id; }
    }
    if (you){
      p=project(you.v);
      if (p.z>=0.1){
        d=(p.x-x)*(p.x-x)+(p.y-y)*(p.y-y);
        if (d<bestD){ bestD=d; best="you"; }
      }
    }
    return best;
  }
  function setHot(id){
    hot=id;
    if (typeof window.__fwPickRegion==="function") window.__fwPickRegion(id && id!=="you" ? id : null);
    paint();
  }
  function tick(now){
    if (window.__fwGpuGlobe){ unmount(); return; }
    raf=0;
    now=now||performance.now();
    var dt=lastTick?Math.min(48, now-lastTick):16;
    lastTick=now;
    if (reduce){
      spinning=false; spinT=0; vYaw=0; vPitch=0;
    } else {
      stepSpin(dt);
      if (!dragging){
        if (Math.abs(vYaw)+Math.abs(vPitch)>0.0004){
          yaw+=vYaw; pitch=clamp(pitch+vPitch, -0.95, 0.95);
          vYaw*=0.92; vPitch*=0.92;
          if (Math.abs(vYaw)+Math.abs(vPitch)<=0.0004){ vYaw=0; vPitch=0; }
        }
      }
      if (spinT>0) yaw+=SPIN*dt*spinEase(spinT);
    }
    paint();
    if (!reduce && (spinT>0.0005 || spinning || (!dragging && Math.abs(vYaw)+Math.abs(vPitch)>0.0004)))
      raf=requestAnimationFrame(tick);
    else lastTick=0;
  }
  function onDown(e){
    if (!e.isPrimary && e.pointerType!=="mouse") return;
    if (!nearGlobe(e)) return;
    dragging=true; moved=false;
    pauseSpin();
    pointerId=e.pointerId;
    lastX=e.clientX; lastY=e.clientY; lastT=e.timeStamp||Date.now();
    vYaw=0; vPitch=0;
    if (!raf && spinT>0){ lastTick=0; raf=requestAnimationFrame(tick); }
    canvas.setPointerCapture(e.pointerId);
    stage.classList.add("is-drag");
  }
  function onMove(e){
    if (!dragging) canvas.style.cursor=nearGlobe(e)?"grab":"default";
    if (dragging){
      var dt=Math.max(8, (e.timeStamp||Date.now())-lastT);
      var dx=e.clientX-lastX, dy=e.clientY-lastY;
      if (Math.abs(dx)+Math.abs(dy)>3) moved=true;
      var k=1.15/Math.max(80, radius);
      var dyaw=dx*k, dpitch=dy*k;
      yaw+=dyaw; pitch=clamp(pitch+dpitch, -0.95, 0.95);
      vYaw=dyaw*(16/dt); vPitch=dpitch*(16/dt);
      lastX=e.clientX; lastY=e.clientY; lastT=e.timeStamp||Date.now();
      paint();
      return;
    }
    var id=pickAt(e.clientX, e.clientY);
    if (id!==hot) setHot(id);
  }
  function onUp(e){
    if (!dragging) return;
    dragging=false;
    stage.classList.remove("is-drag");
    try { canvas.releasePointerCapture(pointerId); } catch (err) {}
    pointerId=null;
    bumpIdle();
    if (!moved) setHot(pickAt(e.clientX, e.clientY));
    if (!reduce && !raf && (spinT>0.0005 || Math.abs(vYaw)+Math.abs(vPitch)>0.0008)){
      lastTick=0; raf=requestAnimationFrame(tick);
    }
  }
  function onLeave(){
    if (!dragging) setHot(null);
  }
  function mount(){
    if (canvas || window.__fwGpuGlobe) return;
    canvas=document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    stage.appendChild(canvas);
    ctx=canvas.getContext("2d");
    labels=document.createElement("canvas");
    labels.className="globe-labels";
    labels.setAttribute("aria-hidden", "true");
    document.body.appendChild(labels);
    lctx=labels.getContext("2d");
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    size();
    bumpIdle();
  }
  function unmount(){
    spinning=false; spinT=0;
    if (idleTimer){ clearTimeout(idleTimer); idleTimer=0; }
    if (raf){ cancelAnimationFrame(raf); raf=0; }
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    if (labels && labels.parentNode) labels.parentNode.removeChild(labels);
    canvas=null; ctx=null; labels=null; lctx=null;
    stage.classList.remove("is-drag");
    dragging=false;
  }
  function refresh(){
    if (window.__fwGpuGlobe){ unmount(); return; }
    reduce=reduceMq.matches;
    land=readLand();
    var ok=readScene();
    if (!desktop() || !ok){
      stage.hidden=true;
      unmount();
      if (!desktop()) syncGutter(false);
      return;
    }
    stage.hidden=false;
    mount();
    size();
    paint();
    if (!reduce) bumpIdle();
  }
  window.__fwGlobe={ refresh:function(){ if (window.__fwGpuGlobe) return; refresh(); }, paint:function(){ if (window.__fwGpuGlobe) return; if (ctx) paint(); } };
  mq.addEventListener("change", function(){ if (!window.__fwGpuGlobe) refresh(); });
  reduceMq.addEventListener("change", function(){ if (!window.__fwGpuGlobe) refresh(); });
  window.addEventListener("resize", function(){ if (window.__fwGpuGlobe) return; if (canvas){ size(); paint(); } });
  new MutationObserver(function(){ if (window.__fwGpuGlobe) return; if (ctx) paint(); }).observe(document.documentElement, { attributes:true, attributeFilter:["data-theme"] });
  window.addEventListener("fw-globe-gpu", function(){ unmount(); });
  var gpuPending=typeof navigator.gpu!=="undefined";
  function start2d(){
    if (window.__fwGpuGlobe){ unmount(); return; }
    gpuPending=false;
    refresh();
  }
  if (gpuPending){
    window.addEventListener("fw-globe-fallback", start2d);
    setTimeout(start2d, 2800);
  } else {
    start2d();
  }
})();`;
