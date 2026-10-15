"""Aggregate a local execution journal; optionally export only anonymized market observations.
Never copies accounts, model prose, requests, account identifiers or the symbol mapping.
"""
import argparse, base64, collections, hashlib, json, re, zlib
from decimal import Decimal as D
from pathlib import Path

def analyze(path, fixture=None):
    raw=Path(path).read_bytes(); journal=json.loads(raw); events=journal["events"]
    snapshots=[e for e in events if e["stage"]=="SNAPSHOT" and e.get("purpose")=="STRATEGY"]
    closes=[e for e in snapshots if e["details"]["review_only"]]
    positions=collections.defaultdict(list); exits=[]; fees=D(0);taxes=D(0);fill_count=0;buys=0
    for e in events:
        if e["stage"]!="FILL":continue
        match=re.fullmatch(r"(\w+) (BUY|SELL) (\d+) 股 @ ([\d.]+) · 手續費 ([\d.]+) · 稅 ([\d.]+)",e["message"])
        if not match:raise ValueError("Unrecognized fill; refusing to estimate")
        sym,side,n,p,f,t=match.groups();n=int(n);p,f,t=map(D,[p,f,t]);fees+=f;taxes+=t;fill_count+=1
        if side=="BUY":positions[sym].append([n,p*n+f]);buys+=1
        else:
            left=n;basis=D(0)
            for lot in positions[sym]:
                if not lot[0]:continue
                used=min(left,lot[0]);cost=lot[1]*used/lot[0];basis+=cost;lot[0]-=used;lot[1]-=cost;left-=used
            if left:raise ValueError("Insufficient FIFO inventory in journal")
            exits.append((e["asof"],p*n-f-t-basis))
    last=snapshots[-1]["details"]["account"]; stock=sum(D(p["last_price"])*p["shares"] for p in last["positions"])
    remaining=sum(l[1] for lots in positions.values() for l in lots);realized=sum(p for _,p in exits)
    peak=D(100000);dd=D(0)
    for e in snapshots:
        value=D(e["details"]["account"]["equity"]);peak=max(peak,value);dd=max(dd,(peak-value)/peak)
    wins=[p for _,p in exits if p>0];losses=[p for _,p in exits if p<0]
    buying=[d for e in events if e["stage"]=="DECISION" for d in e["details"]["decisions"] if d["action"]=="BUY"]
    summary={"source_version":journal["version"],"source_sha256":hashlib.sha256(raw).hexdigest(),"scope":journal["scope"],
        "range":[snapshots[0]["asof"],snapshots[-1]["asof"]],"events":len(events),"review_snapshots":len(closes),
        "initial_cash":"100000","final_equity":last["equity"],"net_pnl":str(D(last["equity"])-100000),
        "return_pct":str((D(last["equity"])/100000-1)*100),"realized_pnl":str(realized),"unrealized_after_buy_fees":str(stock-remaining),
        "fees":str(fees),"taxes":str(taxes),"gross_pnl":str(D(last["equity"])-100000+fees+taxes),
        "sampled_peak_equity":str(peak),"snapshot_drawdown_pct_lower_bound":str(dd*100),
        "mean_review_exposure_pct":str(sum(D(e["details"]["capital"]["exposure_fraction"]) for e in closes)/len(closes)*100),
        "final_exposure_pct":str(stock/D(last["equity"])*100),"fill_events":fill_count,"buy_fill_events":buys,
        "sell_fill_events":len(exits),"winning_exit_events":len(wins),"losing_exit_events":len(losses),
        "exit_event_win_rate_pct":str(D(len(wins))/len(exits)*100) if exits else None,
        "average_winning_exit_event":str(sum(wins)/len(wins)) if wins else None,
        "average_losing_exit_event":str(sum(losses)/len(losses)) if losses else None,
        "profit_factor":str(sum(wins)/-sum(losses)) if losses else None,
        "last_day_realized_pnl":str(sum(p for at,p in exits if at[:10]==snapshots[-1]["asof"][:10])),
        "buy_proposals":len(buying),"entry_modes":dict(collections.Counter(d["entry_when"] for d in buying)),
        "trailing_proposals":sum(bool(d.get("smart",{}).get("trailing_fraction")) for d in buying),
        "risk_events":sum(e["stage"]=="RISK" for e in events),"failed_events":sum(e["stage"]=="FAILED" for e in events),
        "limitations":["Snapshot drawdown is only a lower bound on intraday drawdown.","Exit events may differ from exit orders; old journal has no order IDs.",
            "End positions include buy fees and exclude future exit costs.","Review exposure is not time-weighted.",
            "No full minute tape, complete trigger history or unrealized intraday path is present."]}
    if fixture:
        symbols=sorted({c["symbol"] for e in snapshots for c in e["details"]["universe"]}|{s for e in snapshots for s in e["details"].get("instruments",{})})
        codes={symbol:str(9001+i) for i,symbol in enumerate(symbols)};points={};observations=[];skipped=0
        for e in snapshots:
            snap=e["details"];at=snap["asof"];features={};metadata={}
            for symbol,f in snap["features"].items():
                if symbol in codes and f.get("asof"):features[codes[symbol]]=f
            for symbol,m in snap.get("instruments",{}).items():
                if symbol in codes:metadata[codes[symbol]]={**m,"symbol":codes[symbol],"name":"Anonymous "+codes[symbol]}
            observations.append({"at":at,"features":features,"metadata":metadata,"universe":[
                {**c,"symbol":codes[c["symbol"]],"name":"Anonymous "+codes[c["symbol"]],"source":"recorded snapshot"} for c in snap["universe"]]})
            for q in snap.get("quotes",[]):
                if not q["odd"]:continue
                if q["trade_at"]!=q["book_at"] or q["trade_at"]>at or q["simulated"]:skipped+=1;continue
                symbol=codes[q["symbol"]];price=q["last"]
                point={"symbol":symbol,"at":q["trade_at"],"open":price,"high":price,"low":price,"close":price,
                    "volume_shares":0,"bid":q["bid"],"ask":q["ask"],"bid_shares":q["bid_shares"],"ask_shares":q["ask_shares"]}
                key=(symbol,q["trade_at"])
                if key in points and points[key]!=point:raise ValueError("Conflicting observed quotes")
                points[key]=point
        data={"source":"Anonymized v0.2.2 sparse recorded price/feature observations; NOT original Codex replay",
            "synthetic":False,"frequency":"MINUTE","coverage":"SPARSE_OBSERVATIONS","names":{},
            "points":sorted(points.values(),key=lambda p:(p["at"],p["symbol"])),"observations":observations,
            "limitations":["Only recorded snapshots; no interpolated intraday path.","Books are the original replay approximations, not true odd-lot depth.",
                "Volume is unknown and set to zero; only explicit recorded depth may fill.","Recorded completed-day indicators are reused at/after their recorded timestamp.",
                "Symbols are anonymized; no account, model text or symbol mapping is included."]}
        encoded=json.dumps(data,separators=(",",":"),ensure_ascii=False).encode()
        Path(fixture).parent.mkdir(parents=True,exist_ok=True)
        Path(fixture).write_text(base64.b64encode(zlib.compress(encoded,9)).decode()+"\n")
        summary["market_fixture"]={"sha256":hashlib.sha256(encoded).hexdigest(),"symbols":len(codes),"price_points":len(points),
            "observations":len(observations),"discarded_incompatible_quotes":skipped,"bytes":len(encoded)}
    return summary

if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("journal");p.add_argument("--fixture");p.add_argument("--output")
    args=p.parse_args();summary=analyze(args.journal,args.fixture);text=json.dumps(summary,indent=2,ensure_ascii=False)+"\n"
    if args.output:Path(args.output).write_text(text)
    print(text)
