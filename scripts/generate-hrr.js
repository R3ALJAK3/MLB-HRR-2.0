import { useState, useEffect, useCallback } from "react";
import { Search, RefreshCw, X, TrendingUp, Zap, Target, Activity, BarChart3, Clock, Shield, Flame, Snowflake, AlertTriangle, Layers } from "lucide-react";

const GIST = "https://gist.githubusercontent.com/R3ALJAK3/2b4a2e18268a955fd76247ca91156f94/raw/hrr-data.json";
const MLBAPI = "https://statsapi.mlb.com/api/v1";
const TABS = [
  { id: "top", label: "Top Plays", icon: Target },
  { id: "slate", label: "Game Slate", icon: Activity },
  { id: "players", label: "All Players", icon: BarChart3 },
  { id: "stacks", label: "Stacks", icon: Layers },
  { id: "live", label: "Live", icon: Zap },
];

const C = {
  bg:"#050810",surface:"#0c1018",card:"#111827",border:"rgba(148,163,184,0.08)",
  borderHover:"rgba(148,163,184,0.15)",text:"#e2e8f0",muted:"#64748b",dim:"#334155",
  cyan:"#06b6d4",cyanDim:"rgba(6,182,212,0.12)",green:"#10b981",greenDim:"rgba(16,185,129,0.12)",
  amber:"#f59e0b",amberDim:"rgba(245,158,11,0.12)",red:"#ef4444",redDim:"rgba(239,68,68,0.12)",
  purple:"#a78bfa",purpleDim:"rgba(167,139,250,0.1)",
};
const mono="'IBM Plex Mono',monospace";
const sans="'Manrope',system-ui,sans-serif";
const disp="'Syne','Manrope',system-ui,sans-serif";
const fmt=(n,d=2)=>(n||0).toFixed(d);
const tierColor=t=>t==="A"?C.green:t==="B"?C.amber:C.dim;
const confColor=c=>c>=9?C.green:c>=7?C.amber:C.red;
const streakIcon=t=>t==="hot"?<Flame size={12} style={{color:C.red}}/>:t==="warm"?<Flame size={12} style={{color:C.amber}}/>:t==="cold"?<Snowflake size={12} style={{color:C.cyan}}/>:null;
function breakdown(h,o,p){return p?.hProj!=null?{h:p.hProj,r:p.rProj,rbi:p.rbiProj}:{h:0,r:0,rbi:0}}
function nowET(){return new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}))}
function gameTime(g){if(!g.time)return new Date(0);const[ts,ap]=g.time.split(" ");let[h,m]=ts.split(":").map(Number);if(ap==="PM"&&h!==12)h+=12;if(ap==="AM"&&h===12)h=0;const d=nowET();d.setHours(h,m,0,0);return d}

function ConfRing({value,size=44,stroke=2.5}){const r=(size-stroke)/2,circ=2*Math.PI*r,pct=Math.min(value/10,1),color=confColor(value);return(<svg width={size} height={size} style={{transform:"rotate(-90deg)"}}><circle cx={size/2} cy={size/2} r={r} fill="none" stroke={C.border} strokeWidth={stroke}/><circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeDasharray={circ} strokeDashoffset={circ*(1-pct)} strokeLinecap="round" style={{transition:"stroke-dashoffset 1s ease-out"}}/></svg>)}
function TierBadge({tier,size="sm"}){const bg=tier==="A"?C.greenDim:tier==="B"?C.amberDim:"rgba(100,116,139,0.12)",fg=tierColor(tier),px=size==="lg"?"8px 14px":"2px 8px",fs=size==="lg"?13:10;return<span style={{background:bg,color:fg,padding:px,borderRadius:4,fontSize:fs,fontWeight:700,fontFamily:mono,letterSpacing:0.5}}>{tier}</span>}
function HandBadge({hand}){const isL=hand==="L";return<span style={{fontSize:9,fontWeight:700,fontFamily:mono,padding:"2px 5px",borderRadius:3,background:isL?"rgba(96,165,250,0.15)":C.purpleDim,color:isL?"#60a5fa":C.purple}}>{isL?"LHP":"RHP"}</span>}
function StatCard({label,value,sub,color,delay=0}){return(<div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"14px 16px",animation:`fadeUp 0.4s ease-out ${delay}s both`}}><div style={{fontSize:10,fontWeight:600,color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>{label}</div><div style={{fontSize:22,fontWeight:700,fontFamily:mono,color:color||C.text}}>{value}</div>{sub&&<div style={{fontSize:10,color:C.dim,marginTop:2}}>{sub}</div>}</div>)}

function TopPlayCard({p,rank,games,live,onClick,delay}){
  const gm=games?.find(g=>g.id===p.gameId),sp=gm?(p.team===gm.home?.abbr?gm.away?.pitcher:gm.home?.pitcher):null;
  const bd=breakdown(p.hrr,p.order,p);
  const isFinal=gm?.gamePk&&live[gm.gamePk]?.status?.abstractGameState==="Final";
  const isLive=gm?.gamePk&&live[gm.gamePk]?.status?.abstractGameState==="Live";
  return(
    <div onClick={()=>onClick(p)} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"14px 16px",cursor:"pointer",transition:"all 0.2s ease",animation:`fadeUp 0.5s ease-out ${delay}s both`}} onMouseEnter={e=>{e.currentTarget.style.borderColor=C.borderHover;e.currentTarget.style.transform="translateY(-1px)"}} onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.transform="none"}}>
      <div style={{display:"flex",alignItems:"center",gap:14}}>
        <div style={{position:"relative",flexShrink:0}}><ConfRing value={p.confidence||0}/><div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:700,fontFamily:mono,color:C.text}}>{rank}</div></div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
            <span style={{fontSize:14,fontWeight:600,color:C.text,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{p.name}</span>
            {streakIcon(p.streakType)}{p.injured&&<AlertTriangle size={11} style={{color:C.amber}}/>}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:C.muted,flexWrap:"wrap"}}>
            <span style={{background:"rgba(148,163,184,0.08)",padding:"1px 6px",borderRadius:3,fontWeight:600,fontSize:10}}>{p.team}</span>
            <span>{p.pos} · #{p.order}</span>
            {sp&&<><span>vs</span><span style={{color:C.text,fontWeight:500}}>{sp.name}</span><HandBadge hand={sp.hand}/></>}
          </div>
        </div>
        <div style={{display:"flex",gap:12,alignItems:"center",flexShrink:0}}>
          <div style={{textAlign:"center"}}><span style={{fontSize:9,color:C.dim,fontFamily:mono}}>CONF</span><div style={{fontSize:13,fontWeight:700,fontFamily:mono,color:confColor(p.confidence||0)}}>{p.confidence||"—"}</div></div>
          <div style={{width:1,height:28,background:C.border}}/>
          <div style={{textAlign:"right"}}><div style={{fontSize:20,fontWeight:700,fontFamily:mono,color:tierColor(p.tier),lineHeight:1}}>{fmt(p.hrr)}</div><div style={{fontSize:9,fontFamily:mono,color:C.dim,marginTop:2}}>H{fmt(bd.h)} R{fmt(bd.r)} RBI{fmt(bd.rbi)}</div></div>
          <TierBadge tier={p.tier}/>
        </div>
        {isLive&&<span style={{fontSize:10,fontWeight:700,color:C.green,animation:"pulse 2s infinite"}}>● LIVE</span>}
      </div>
    </div>
  );
}

function PlayerModal({player:p,games,onClose}){
  if(!p)return null;
  const gm=games?.find(g=>g.id===p.gameId),sp=gm?(p.team===gm.home?.abbr?gm.away?.pitcher:gm.home?.pitcher):null;
  const bd=breakdown(p.hrr,p.order,p);
  const Sec=({title,children})=>(<div style={{marginTop:16}}><div style={{fontSize:9,fontWeight:700,color:C.dim,textTransform:"uppercase",letterSpacing:1.5,marginBottom:8,paddingBottom:4,borderBottom:`1px solid ${C.border}`}}>{title}</div>{children}</div>);
  const St=({label,value,color})=>(<div style={{background:"rgba(148,163,184,0.04)",borderRadius:8,padding:"8px 10px"}}><div style={{fontSize:9,color:C.dim,textTransform:"uppercase",letterSpacing:0.5,marginBottom:2}}>{label}</div><div style={{fontSize:16,fontWeight:600,fontFamily:mono,color:color||C.text}}>{value}</div></div>);
  return(
    <div onClick={onClose} style={{position:"fixed",inset:0,zIndex:1000,display:"flex",alignItems:"flex-start",justifyContent:"center",paddingTop:60,background:"rgba(0,0,0,0.6)",backdropFilter:"blur(4px)",animation:"fadeIn 0.2s ease-out"}}>
      <div onClick={e=>e.stopPropagation()} style={{background:C.surface,border:`1px solid ${C.borderHover}`,borderRadius:16,padding:24,maxWidth:480,width:"95%",maxHeight:"80vh",overflowY:"auto",animation:"slideUp 0.3s ease-out"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
          <div><div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}><span style={{fontSize:20,fontWeight:700,fontFamily:disp}}>{p.name}</span>{streakIcon(p.streakType)}<TierBadge tier={p.tier} size="lg"/></div>
          <div style={{fontSize:12,color:C.muted}}><span style={{background:"rgba(148,163,184,0.08)",padding:"1px 6px",borderRadius:3,fontWeight:600,fontSize:10}}>{p.team}</span> {p.pos} · #{p.order} · {p.bats}H · {p.isHome?"Home":"Away"}{gm?` · ${gm.time} ET`:""}</div></div>
          <button onClick={onClose} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",padding:4}}><X size={18}/></button>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginTop:16}}>
          <St label="HRR Proj" value={fmt(p.hrr)} color={tierColor(p.tier)}/><St label="Confidence" value={p.confidence||"—"} color={confColor(p.confidence||0)}/><St label="Pick Score" value={p.pickScore?fmt(p.pickScore):"—"}/>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginTop:6}}>
          <St label="H" value={fmt(bd.h)} color={C.green}/><St label="R" value={fmt(bd.r)} color={C.cyan}/><St label="RBI" value={fmt(bd.rbi)} color={C.amber}/>
        </div>
        <Sec title="Season"><div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
          <St label="AVG" value={p.avg?(p.avg*1000|0)/1000:"—"}/><St label="OPS" value={(p.ops||0).toFixed(3)}/><St label="wRC+" value={p.wrcPlus||"—"}/>
          <St label="L10 AVG" value={p.last10Avg?(p.last10Avg*1000|0)/1000:"—"} color={p.streakType==="hot"?C.green:p.streakType==="cold"?C.cyan:undefined}/><St label="Barrel%" value={p.barrelPct!=null?p.barrelPct.toFixed(1)+"%":"—"}/><St label="HardHit%" value={p.hardHitPct!=null?p.hardHitPct.toFixed(1)+"%":"—"}/>
        </div></Sec>
        {sp&&<Sec title={`vs ${sp.name}`}><div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8,fontSize:12,color:C.muted}}><HandBadge hand={sp.hand}/><span>{fmt(sp.era)} ERA · {sp.k9||"?"} K/9</span>{sp.last3ERA!=null&&<span style={{color:sp.last3ERA<3.5?C.green:sp.last3ERA>5?C.red:C.muted}}>L3: {sp.last3ERA.toFixed(2)}</span>}</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
          <St label="BvP AVG" value={p.bvp?p.bvp.avg.toFixed(3):"—"} color={p.bvp?.avg>=.3?C.green:p.bvp?.avg<.2?C.red:undefined}/><St label="BvP AB" value={p.bvp?p.bvp.ab:"—"}/><St label="Platoon" value={sp?((p.bats==="L"&&sp.hand==="R")||(p.bats==="R"&&sp.hand==="L")?"✓ Fav":"Same"):"—"} color={sp?((p.bats==="L"&&sp.hand==="R")||(p.bats==="R"&&sp.hand==="L")?C.green:C.amber):undefined}/>
        </div></Sec>}
        {gm&&<Sec title="Environment"><div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
          <St label="Env Score" value={gm.envScore||"—"} color={gm.envScore>=7?C.green:gm.envScore>=4?C.amber:C.cyan}/><St label="Park" value={(gm.parkFactor||1).toFixed(2)+"×"}/><St label="Impl Runs" value={p.impliedRuns?p.impliedRuns.toFixed(1):"—"}/>
        </div>{gm.weatherNote&&<div style={{fontSize:11,color:C.dim,marginTop:6}}>{gm.weatherNote}</div>}</Sec>}
      </div>
    </div>
  );
}

function GameCard({g,allPlayers}){
  const ap=(allPlayers||[]).filter(p=>p.team===g.away?.abbr&&p.gameId===g.id).sort((a,b)=>a.order-b.order);
  const hp=(allPlayers||[]).filter(p=>p.team===g.home?.abbr&&p.gameId===g.id).sort((a,b)=>a.order-b.order);
  const PL=({sp})=>sp?<div style={{fontSize:11,color:C.muted,marginBottom:8}}><strong style={{color:C.text,fontWeight:500}}>{sp.name}</strong> <HandBadge hand={sp.hand}/> <span style={{fontFamily:mono}}>{fmt(sp.era)} ERA</span>{sp.last3ERA!=null&&<span style={{marginLeft:6,fontSize:10,color:sp.last3ERA<3.5?C.green:sp.last3ERA>5?C.red:C.muted}}>L3:{sp.last3ERA.toFixed(2)}</span>}</div>:null;
  const LR=({players})=>{
    if(!players.length)return<div style={{padding:"16px 0",textAlign:"center",color:C.dim,fontSize:11,border:`1px dashed ${C.border}`,borderRadius:6}}>Awaiting lineup</div>;
    return players.map(p=>{const bd=breakdown(p.hrr,p.order,p);return(
      <div key={p.name+p.order} style={{display:"grid",gridTemplateColumns:"16px 1fr 28px 36px 42px",gap:2,padding:"3px 4px",fontSize:11,alignItems:"center",borderRadius:4,background:p.tier==="A"?"rgba(16,185,129,0.05)":p.tier==="B"?"rgba(245,158,11,0.04)":"transparent"}}>
        <span style={{fontFamily:mono,fontSize:9,color:C.dim}}>{p.order}</span>
        <span style={{whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",color:p.tier==="A"?C.green:p.tier==="B"?C.amber:C.text,fontWeight:p.tier==="A"?600:400}}>{p.name}</span>
        <span style={{fontSize:9,color:C.dim,textAlign:"center"}}>{p.pos}</span>
        <span style={{fontFamily:mono,textAlign:"right",fontSize:10,color:C.muted}}>H{fmt(bd.h,1)}</span>
        <span style={{fontFamily:mono,textAlign:"right",fontWeight:600,color:tierColor(p.tier)}}>{fmt(p.hrr)}</span>
      </div>)});
  };
  return(
    <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:16,marginBottom:10}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
        <div><div style={{fontSize:16,fontWeight:700,fontFamily:disp}}>{g.away?.abbr} <span style={{color:C.dim,fontWeight:400}}>@</span> {g.home?.abbr}</div><div style={{fontSize:11,color:C.muted,marginTop:2}}>{g.time} ET · {g.stadium}</div></div>
        <div style={{textAlign:"right",fontSize:10,fontFamily:mono,color:C.muted}}>
          {g.envScore&&<span style={{padding:"2px 6px",borderRadius:4,fontWeight:700,background:g.envScore>=7?C.greenDim:g.envScore>=4?C.amberDim:C.cyanDim,color:g.envScore>=7?C.green:g.envScore>=4?C.amber:C.cyan,marginRight:6}}>ENV {g.envScore}</span>}
          PF {(g.parkFactor||1).toFixed(2)}{g.oddsLine&&<div style={{color:C.amber,marginTop:2}}>O/U {g.oddsLine.total}</div>}
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        <div><div style={{fontSize:10,fontWeight:600,textTransform:"uppercase",letterSpacing:0.8,color:C.muted,paddingBottom:4,borderBottom:`1px solid ${C.border}`,marginBottom:6}}>{g.away?.name}</div><PL sp={g.away?.pitcher}/><LR players={ap}/></div>
        <div><div style={{fontSize:10,fontWeight:600,textTransform:"uppercase",letterSpacing:0.8,color:C.muted,paddingBottom:4,borderBottom:`1px solid ${C.border}`,marginBottom:6}}>{g.home?.name}</div><PL sp={g.home?.pitcher}/><LR players={hp}/></div>
      </div>
    </div>
  );
}

function PlayersGrid({data,onPlayerClick}){
  const[sk,setSk]=useState("pickScore"),[sd,setSd]=useState(-1),[search,setSearch]=useState(""),[tf,setTf]=useState(""),[tier,setTier]=useState("");
  const players=(data?.allPlayers||[]).filter(p=>{if(search&&!p.name.toLowerCase().includes(search.toLowerCase()))return false;if(tf&&p.team!==tf)return false;if(tier&&p.tier!==tier)return false;return true}).sort((a,b)=>{const av=a[sk],bv=b[sk];return typeof av==="string"?av.localeCompare(bv)*sd:((bv||0)-(av||0))*-sd});
  const teams=[...new Set((data?.allPlayers||[]).map(p=>p.team))].sort();
  const cols=[{k:"name",l:"Player"},{k:"team",l:"Team"},{k:"order",l:"#"},{k:"avg",l:"AVG"},{k:"ops",l:"OPS"},{k:"wrcPlus",l:"wRC+"},{k:"barrelPct",l:"Brl%"},{k:"confidence",l:"Conf"},{k:"hrr",l:"HRR"},{k:"pickScore",l:"Pick"},{k:"tier",l:"Tier"}];
  const hs=k=>{sk===k?setSd(d=>d*-1):(setSk(k),setSd(-1))};
  return(
    <div style={{animation:"fadeUp 0.3s ease-out"}}>
      <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
        <div style={{position:"relative",flex:"0 0 200px"}}><Search size={14} style={{position:"absolute",left:10,top:9,color:C.muted}}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search player..." style={{width:"100%",background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:"7px 10px 7px 30px",color:C.text,fontSize:12,outline:"none",fontFamily:sans}}/></div>
        <select value={tf} onChange={e=>setTf(e.target.value)} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:"7px 10px",color:C.text,fontSize:12,outline:"none"}}><option value="">All Teams</option>{teams.map(t=><option key={t}>{t}</option>)}</select>
        <select value={tier} onChange={e=>setTier(e.target.value)} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:"7px 10px",color:C.text,fontSize:12,outline:"none"}}><option value="">All Tiers</option><option>A</option><option>B</option><option>C</option></select>
        <span style={{fontSize:11,color:C.muted,fontFamily:mono}}>{players.length} players</span>
      </div>
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,overflow:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,fontFamily:sans,minWidth:700}}>
          <thead><tr>{cols.map(c=><th key={c.k} onClick={()=>hs(c.k)} style={{textAlign:c.k==="name"?"left":"center",padding:"10px 8px",fontSize:9,fontWeight:600,color:sk===c.k?C.cyan:C.muted,cursor:"pointer",textTransform:"uppercase",letterSpacing:0.8,borderBottom:`1px solid ${C.border}`,whiteSpace:"nowrap",userSelect:"none"}}>{c.l}{sk===c.k?(sd===-1?" ↓":" ↑"):""}</th>)}</tr></thead>
          <tbody>{players.slice(0,80).map(p=>(
            <tr key={p.name+p.team} onClick={()=>onPlayerClick(p)} style={{cursor:"pointer"}} onMouseEnter={e=>e.currentTarget.style.background="rgba(255,255,255,0.02)"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
              <td style={{padding:"6px 8px",fontWeight:p.tier==="A"?600:400,borderBottom:`1px solid ${C.border}`}}>{p.name} {streakIcon(p.streakType)}</td>
              <td style={{textAlign:"center",borderBottom:`1px solid ${C.border}`}}><span style={{background:"rgba(148,163,184,0.08)",padding:"1px 5px",borderRadius:3,fontSize:10,fontWeight:600,color:C.muted}}>{p.team}</span></td>
              <td style={{textAlign:"center",fontFamily:mono,color:C.muted,borderBottom:`1px solid ${C.border}`}}>{p.order}</td>
              <td style={{textAlign:"center",fontFamily:mono,borderBottom:`1px solid ${C.border}`}}>{p.avg?(p.avg*1000|0)/1000:"—"}</td>
              <td style={{textAlign:"center",fontFamily:mono,borderBottom:`1px solid ${C.border}`}}>{(p.ops||0).toFixed(3)}</td>
              <td style={{textAlign:"center",fontFamily:mono,borderBottom:`1px solid ${C.border}`}}>{p.wrcPlus||"—"}</td>
              <td style={{textAlign:"center",fontFamily:mono,borderBottom:`1px solid ${C.border}`}}>{p.barrelPct!=null?p.barrelPct.toFixed(1)+"%":"—"}</td>
              <td style={{textAlign:"center",fontFamily:mono,fontWeight:600,color:confColor(p.confidence||0),borderBottom:`1px solid ${C.border}`}}>{p.confidence||"—"}</td>
              <td style={{textAlign:"center",fontFamily:mono,fontWeight:700,color:tierColor(p.tier),borderBottom:`1px solid ${C.border}`}}>{fmt(p.hrr)}</td>
              <td style={{textAlign:"center",fontFamily:mono,color:C.muted,borderBottom:`1px solid ${C.border}`}}>{p.pickScore?fmt(p.pickScore):"—"}</td>
              <td style={{textAlign:"center",borderBottom:`1px solid ${C.border}`}}><TierBadge tier={p.tier}/></td>
            </tr>))}</tbody>
        </table>
      </div>
    </div>
  );
}

function LiveCard({g}){
  const[expanded,setExpanded]=useState(false),[bs,setBs]=useState(null);
  const st=g.status?.abstractGameState,aa=g.teams?.away?.team?.abbreviation||"?",ha=g.teams?.home?.team?.abbreviation||"?";
  const ar=g.teams?.away?.score??"—",hr=g.teams?.home?.score??"—",ls=g.linescore;
  const isLive=st==="Live",isFinal=st==="Final",inn=ls?`${ls.inningHalf==="Top"?"▲":"▼"} ${ls.currentInningOrdinal||""}`:"";
  const toggle=async()=>{if(expanded){setExpanded(false);return}setExpanded(true);if(!bs){try{const r=await fetch(`${MLBAPI}/game/${g.gamePk}/boxscore`);setBs(await r.json())}catch{}}};
  return(
    <div onClick={toggle} style={{background:C.card,border:`1px solid ${isLive?"rgba(16,185,129,0.25)":C.border}`,borderRadius:12,padding:"14px 16px",marginBottom:8,cursor:"pointer",transition:"border-color 0.2s"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div><div style={{fontSize:15,fontWeight:700,fontFamily:disp}}>{aa} @ {ha}<span style={{marginLeft:6,fontSize:10,color:C.dim}}>{expanded?"▲":"▼"}</span></div><div style={{fontSize:11,color:C.muted,marginTop:2}}>{g.venue?.name||""}</div></div>
        <div style={{textAlign:"right"}}><div style={{fontSize:22,fontWeight:700,fontFamily:mono,color:isLive?C.green:C.text}}>{ar} – {hr}</div><span style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:4,background:isLive?C.greenDim:isFinal?"rgba(148,163,184,0.08)":C.cyanDim,color:isLive?C.green:isFinal?C.muted:C.cyan}}>{isLive?inn:isFinal?"Final":"—"}</span></div>
      </div>
      {expanded&&bs&&<div style={{marginTop:12,borderTop:`1px solid ${C.border}`,paddingTop:10}}>
        {["away","home"].map(side=>{const td=bs.teams?.[side];if(!td)return null;const abbr=td.team?.abbreviation||"?";return(
          <div key={side} style={{marginBottom:side==="away"?10:0}}><div style={{fontSize:11,fontWeight:600,color:C.text,marginBottom:4}}>{abbr}</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr repeat(5,30px) 36px",gap:2,fontSize:11,fontFamily:mono}}>
              <div style={{color:C.dim,fontSize:9}}>Player</div>{["AB","H","R","RBI","K","HRR"].map(h=><div key={h} style={{color:C.dim,fontSize:9,textAlign:"center"}}>{h}</div>)}
              {(td.battingOrder||[]).map(id=>{const pl=td.players?.["ID"+id];if(!pl?.stats?.batting)return null;const s=pl.stats.batting,hrr=(parseInt(s.hits||0))+(parseInt(s.runs||0))+(parseInt(s.rbi||0));return(
                <React.Fragment key={id}><div style={{color:C.text,fontFamily:sans,fontSize:11,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{pl.person?.fullName}<span style={{color:C.dim,fontSize:9,marginLeft:4}}>{pl.position?.abbreviation}</span></div>
                <div style={{textAlign:"center"}}>{s.atBats||0}</div><div style={{textAlign:"center"}}>{s.hits||0}</div><div style={{textAlign:"center"}}>{s.runs||0}</div><div style={{textAlign:"center"}}>{s.rbi||0}</div><div style={{textAlign:"center"}}>{s.strikeOuts||0}</div>
                <div style={{textAlign:"center",fontWeight:700,color:hrr>=3?C.green:hrr>=2?C.amber:C.muted}}>{hrr}</div></React.Fragment>)})}
            </div></div>)})}
      </div>}
    </div>
  );
}

export default function App(){
  const[data,setData]=useState(null),[live,setLive]=useState({}),[tab,setTab]=useState("top"),[loading,setLoading]=useState(true),[err,setErr]=useState(null),[sel,setSel]=useState(null);
  const fetchD=useCallback(async()=>{try{const r=await fetch(GIST+"?t="+Date.now());if(!r.ok)throw new Error("HTTP "+r.status);setData(await r.json());setLoading(false)}catch(e){setErr(e.message);setLoading(false)}},[]);
  const fetchL=useCallback(async()=>{try{const today=new Date().toLocaleDateString("en-CA",{timeZone:"America/New_York"}),r=await fetch(`${MLBAPI}/schedule?sportId=1&date=${today}&hydrate=team,linescore`),d=await r.json(),g=d.dates?.[0]?.games||{},m={};(d.dates?.[0]?.games||[]).forEach(g=>m[g.gamePk]=g);setLive(m)}catch{}},[]);
  useEffect(()=>{fetchD();fetchL();const t=setInterval(fetchL,60000);return()=>clearInterval(t)},[fetchD,fetchL]);

  const top10=(data?.dailyTop10||[]).filter(p=>!p.isTBD&&p.name!=="Lineup TBD");
  const upGames=(data?.games||[]).filter(g=>gameTime(g)>nowET());
  const liveGames=Object.values(live);
  const liveCount=liveGames.filter(g=>g.status?.abstractGameState==="Live").length;
  const gen=data?.generatedAt?new Date(data.generatedAt):null;
  const age=gen?Math.round((Date.now()-gen.getTime())/60000):null;
  const ageStr=age!=null?(age<60?age+"m ago":Math.floor(age/60)+"h ago"):"";

  return(
    <div style={{background:C.bg,minHeight:"100vh",color:C.text,fontFamily:sans}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=Manrope:wght@400;500;600;700&family=Syne:wght@600;700;800&display=swap');
        @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
        @keyframes fadeIn{from{opacity:0}to{opacity:1}}
        @keyframes slideUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
        @keyframes spin{to{transform:rotate(360deg)}}
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:rgba(148,163,184,0.15);border-radius:3px}
        ::selection{background:rgba(6,182,212,0.3)}
      `}</style>

      <header style={{background:C.surface,borderBottom:`1px solid ${C.border}`,padding:"12px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:100,backdropFilter:"blur(12px)"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:8,height:8,borderRadius:"50%",background:C.green,animation:"pulse 2s infinite",boxShadow:`0 0 8px ${C.green}`}}/>
          <span style={{fontSize:16,fontWeight:800,fontFamily:disp,letterSpacing:-0.5}}>MLB HRR</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          {data&&<span style={{fontSize:11,color:C.muted,fontFamily:mono}}>{data.date} · {data.games?.length||0} games · {ageStr}</span>}
          <span style={{fontSize:10,fontWeight:700,padding:"3px 8px",borderRadius:4,fontFamily:mono,background:age!=null&&age>720?C.amberDim:C.greenDim,color:age!=null&&age>720?C.amber:C.green}}>{age!=null&&age>720?"STALE":"LIVE"}</span>
          <button onClick={()=>{fetchD();fetchL()}} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:6,padding:"5px 8px",color:C.muted,cursor:"pointer",display:"flex"}}><RefreshCw size={13}/></button>
        </div>
      </header>

      {data&&<nav style={{background:C.surface,borderBottom:`1px solid ${C.border}`,display:"flex",padding:"0 16px",overflowX:"auto"}}>
        {TABS.map(t=>{const Icon=t.icon,active=tab===t.id,badge=t.id==="live"&&liveCount>0?liveCount+" LIVE":null;return(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{background:"none",border:"none",borderBottom:`2px solid ${active?C.cyan:"transparent"}`,padding:"10px 14px",fontSize:12,fontWeight:active?600:400,fontFamily:sans,color:active?C.text:C.muted,cursor:"pointer",display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap",transition:"all 0.15s",flexShrink:0}}>
            <Icon size={13} style={{opacity:active?1:0.5}}/>{t.label}
            {badge&&<span style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:3,background:C.greenDim,color:C.green,fontFamily:mono}}>{badge}</span>}
          </button>)})}
      </nav>}

      <main style={{maxWidth:1200,margin:"0 auto",padding:"20px 16px"}}>
        {loading&&<div style={{display:"flex",flexDirection:"column",alignItems:"center",padding:"80px 0",gap:12}}><div style={{width:24,height:24,border:`2px solid ${C.border}`,borderTopColor:C.cyan,borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/><span style={{fontSize:13,color:C.muted}}>Loading projections...</span></div>}
        {err&&<div style={{background:C.redDim,border:"1px solid rgba(239,68,68,0.2)",borderRadius:10,padding:16,color:C.red,fontSize:13}}>{err}</div>}

        {data&&tab==="top"&&<div style={{animation:"fadeUp 0.3s ease-out"}}>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:8,marginBottom:20}}>
            <StatCard label="Today's Picks" value={top10.length} delay={0}/>
            <StatCard label="Avg Confidence" value={top10.length?(top10.reduce((s,p)=>s+(p.confidence||0),0)/top10.length).toFixed(1):"—"} color={C.green} delay={0.05}/>
            <StatCard label="Top HRR" value={top10.length?fmt(top10[0]?.hrr):"—"} delay={0.1}/>
            <StatCard label="Lineups" value={`${(data.games||[]).filter(g=>g.awayLineupAvailable||g.homeLineupAvailable).length}/${(data.games||[]).length}`} color={C.cyan} delay={0.15}/>
          </div>
          {!top10.length?<div style={{textAlign:"center",padding:"60px 20px",color:C.muted}}><Target size={32} style={{opacity:0.3,marginBottom:12}}/><div style={{fontSize:14}}>No players meet confidence ≥ 9.0 yet</div><div style={{fontSize:12,color:C.dim,marginTop:4}}>More picks appear as lineups post</div></div>
          :<div style={{display:"flex",flexDirection:"column",gap:6}}>{top10.map((p,i)=><TopPlayCard key={p.name+p.team} p={p} rank={i+1} games={data.games} live={live} onClick={setSel} delay={0.05*i}/>)}</div>}
          <div style={{fontSize:10,color:C.dim,marginTop:12}}>Ranked by pick score (HRR × confidence) · Confidence ≥ 9.0 required</div>
        </div>}

        {data&&tab==="slate"&&<div style={{animation:"fadeUp 0.3s ease-out"}}>{upGames.length===0?<div style={{textAlign:"center",padding:"60px 20px",color:C.muted}}><Clock size={32} style={{opacity:0.3,marginBottom:12}}/><div>All games started — check Live</div></div>:upGames.map(g=><GameCard key={g.id} g={g} allPlayers={data.allPlayers}/>)}</div>}

        {data&&tab==="players"&&<PlayersGrid data={data} onPlayerClick={setSel}/>}

        {data&&tab==="stacks"&&<div style={{animation:"fadeUp 0.3s ease-out"}}>{["stacks2","stacks3","gameStacks"].map(key=>{const stacks=data[key]||[];if(!stacks.length)return null;const title=key==="stacks2"?"2-Player Stacks":key==="stacks3"?"3-Player Stacks":"Game Stacks (O/U 9+)";return(<div key={key} style={{marginBottom:24}}><div style={{fontSize:13,fontWeight:600,marginBottom:8}}>{title}</div>{stacks.map((s,i)=>(<div key={i} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"10px 14px",marginBottom:6,display:"flex",alignItems:"center",gap:12}}><span style={{fontFamily:mono,fontSize:11,color:C.dim,minWidth:18}}>{i+1}</span><div style={{minWidth:60}}><span style={{fontWeight:600,fontSize:12}}>{s.team||`${s.away}@${s.home}`}</span><div style={{fontSize:10,color:C.dim}}>{s.opp?`vs ${s.opp}`:""} {s.time}{s.impliedRuns&&<span style={{color:C.amber}}> · {s.impliedRuns.toFixed(1)}</span>}</div></div><div style={{flex:1,display:"flex",gap:6,flexWrap:"wrap",fontSize:12}}>{(s.players||[]).map((p,j)=><span key={j} style={{color:(p.tier||"")==="A"?C.green:(p.tier||"")==="B"?C.amber:C.text}}>{p.name} <span style={{fontFamily:mono,fontSize:10,color:C.dim}}>{fmt(p.hrr)}</span></span>)}</div><span style={{fontFamily:mono,fontSize:16,fontWeight:700,color:C.green}}>{(s.total||s.stackTotal||0).toFixed(2)}</span></div>))}</div>)})}</div>}

        {data&&tab==="live"&&<div style={{animation:"fadeUp 0.3s ease-out"}}>{liveGames.length===0?<div style={{textAlign:"center",padding:"60px 20px",color:C.muted}}><Activity size={32} style={{opacity:0.3,marginBottom:12}}/><div>Checking scores... updates every 60s</div></div>:<>{[["Live",g=>g.status?.abstractGameState==="Live"],["Final",g=>g.status?.abstractGameState==="Final"],["Upcoming",g=>g.status?.abstractGameState==="Preview"]].map(([label,filter])=>{const f=liveGames.filter(filter);if(!f.length)return null;return<div key={label} style={{marginBottom:16}}><div style={{fontSize:11,fontWeight:600,color:label==="Live"?C.green:C.muted,marginBottom:6}}>{label==="Live"&&"● "}{label} ({f.length})</div>{f.map(g=><LiveCard key={g.gamePk} g={g}/>)}</div>})}</>}</div>}
      </main>

      {sel&&<PlayerModal player={sel} games={data?.games} onClose={()=>setSel(null)}/>}
    </div>
  );
}
