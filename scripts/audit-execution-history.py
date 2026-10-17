"""Offline Decimal/FIFO audit. Outputs contain PRIVATE account records, never commit them.
python scripts/audit-execution-history.py HISTORY.json --output PRIVATE_DIRECTORY
No broker/network access. Sparse snapshots cannot reconstruct an unobserved market path.
"""
import argparse
import collections
import csv
import datetime as dt
import decimal
import hashlib
import json
import pathlib
import re
D = decimal.Decimal
decimal.getcontext().prec = 30
FILL = re.compile(r'(\d+) (BUY|SELL) (\d+) 股 @ ([\d.]+) · 手續費 ([\d.]+) · 稅 ([\d.]+)')
SUBMIT = re.compile(r'(\d+) (BUY|SELL) \d+/(\d+) 股 · (\w+) · 限價 ([\d.]+)')
def timestamp(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
def day(value):
    return timestamp(value).astimezone(dt.timezone(dt.timedelta(hours=8))).date().isoformat()
def drawdown(samples):
    peak, maximum = D(0), D(0)
    for s in samples:
        e = D(s['equity']); peak = max(peak, e)
        if peak > 0: maximum = max(maximum, (peak-e)/peak*100)
    final = D(samples[-1]['equity']) if samples else None
    return dict(peak=peak, maximum_pct=maximum, peak_to_final_pct=(peak-final)/peak*100 if peak and final is not None else None)
def audit(document):
    events = document['events']
    if any(timestamp(a['asof']) > timestamp(b['asof']) for a,b in zip(events,events[1:])):
        raise ValueError('Virtual event time is not monotone')
    lots, fills, trades, snapshots, sizing = collections.defaultdict(list), [], [], [], []
    requests, decisions, submissions, triggers, protections, episodes = {}, {}, {}, {}, {}, {}
    usage, calls, models, full = collections.Counter(), collections.Counter(), collections.Counter(), []
    for index,e in enumerate(events):
        stage, at, msg, s = e['stage'], e['asof'], e['message'], e.get('details')
        if stage=='SNAPSHOT' and isinstance(s,dict):
            snapshots.append(dict(index=index,**s))
            if 'universe' in s:
                full.append(s); protections.update(s.get('existing_protection',{}))
            elif 'request_id' in s: requests[s['request_id']]=s
        if stage=='MODEL':
            models[(e.get('model'),e.get('reasoning'))]+=1;calls[e.get('purpose','UNKNOWN')]+=1
        if stage=='USAGE' and isinstance(s,dict):
            usage.update({k:v or 0 for k,v in s.items() if isinstance(v,(int,float)) or v is None})
        if stage=='OUTPUT' and e.get('purpose')!='EXECUTION':
            try: analysis=json.loads(msg)
            except ValueError: continue
            if not full or full[-1].get('review_only'): continue
            for decision in analysis.get('decisions',[]):
                decisions[decision['symbol']]=decision
                if decision.get('smart'):
                    old=protections.get(decision['symbol'],{})
                    protections[decision['symbol']]=dict(decision['smart'],stop_price=str(max(D(old.get('stop_price',0)),D(decision['smart']['stop_price']))))
        if stage=='SIZE_DECISION' and isinstance(s,dict):
            r=requests.get(s['request_id'])
            if r:
                a=r['account'];sizing.append(dict(at=at,symbol=s['symbol'],action=s['action'],request_id=s['request_id'],
                    strategy_shares=r.get('condition',{}).get('shares'),actual_shares=s['shares'],actual_limit=s['limit_price'],
                    equity=a['equity'],available_cash=a['available_cash'],limits=r['hard_limits'],lots=r['lots'],holdings=a['positions']))
        if stage=='TRIGGER':
            m=re.match(r'(\d+) (BUY|SELL)：(.*)',msg)
            if m:
                symbol,action,reason=m.groups();triggers[(symbol,action)]=dict(at=at,reason=reason,stop_price=protections.get(symbol,{}).get('stop_price'))
        if stage=='SUBMISSION':
            m=SUBMIT.fullmatch(msg)
            if m:
                symbol,action,n,status,limit=m.groups();submissions[(symbol,action)]=dict(at=at,shares=int(n),limit=D(limit),status=status)
        if stage!='FILL': continue
        m=FILL.fullmatch(msg)
        if not m: raise ValueError(f'Unrecognized fill at event {index}')
        symbol,action,n,price,fee,tax=m.groups();n,price,fee,tax=int(n),D(price),D(fee),D(tax)
        if n<=0 or price<=0 or min(fee,tax)<0: raise ValueError('Invalid fill')
        sub,trigger=submissions.get((symbol,action)),triggers.get((symbol,action))
        f=dict(id=(s or {}).get('fill',{}).get('id') if isinstance(s,dict) else None,order_id=(s or {}).get('order_id') if isinstance(s,dict) else None,index=index,at=at,symbol=symbol,action=action,shares=n,price=price,fee=fee,tax=tax,
            submitted_at=sub['at'] if sub else None,limit_price=sub['limit'] if sub else None,
            fill_delay_seconds=(timestamp(at)-timestamp(sub['at'])).total_seconds() if sub else None,
            adverse_vs_limit=(price-sub['limit'])*(1 if action=='BUY' else -1) if sub else None,
            trigger_at=trigger['at'] if trigger else None,trigger=trigger['reason'] if trigger else None,
            stop_price=trigger.get('stop_price') if trigger else None,
            stop_shortfall_per_share=D(trigger['stop_price'])-price if action=='SELL' and trigger and trigger.get('stop_price') else None)
        if action=='BUY':
            snap=next((r for r in reversed(list(requests.values())) if r['symbol']==symbol and r['asof']<=at),None)
            decision=snap.get('condition',{}) if snap else decisions.get(symbol,{})
            lots[symbol].append(dict(shares=n,principal=price*n,fees=fee,at=at))
            ep=episodes.setdefault(symbol,dict(symbol=symbol,entry_at=at,entry_shares=0,entry_principal=D(0),entry_fees=D(0),
                exit_fees=D(0),taxes=D(0),pnl=D(0),entry_when=decision.get('entry_when'),
                features=snap.get('features',{}) if snap else {},stop_price=(decision.get('smart') or {}).get('stop_price')))
            ep['entry_shares']+=n;ep['entry_principal']+=price*n;ep['entry_fees']+=fee
        else:
            needed,principal,buy_fees=n,D(0),D(0)
            entry_at=next((l['at'] for l in lots[symbol] if l['shares']),None)
            for lot in lots[symbol]:
                used=min(needed,lot['shares'])
                if not used: continue
                fraction=D(used)/lot['shares'];p,b=lot['principal']*fraction,lot['fees']*fraction
                lot['shares']-=used;lot['principal']-=p;lot['fees']-=b;needed-=used;principal+=p;buy_fees+=b
            if needed: raise ValueError(f'{symbol}: sell exceeds known inventory; opening positions are missing')
            f.update(net_pnl=price*n-principal-buy_fees-fee-tax,allocated_buy_fees=buy_fees,gross_pnl=price*n-principal,entry_at=entry_at)
            ep=episodes[symbol];ep['pnl']+=f['net_pnl'];ep['exit_fees']+=fee;ep['taxes']+=tax
            if sum(l['shares'] for l in lots[symbol])==0:
                ep.update(exit_at=at,holding_hours=(timestamp(at)-timestamp(ep['entry_at'])).total_seconds()/3600,
                    total_costs=ep['entry_fees']+ep['exit_fees']+ep['taxes'],exit_trigger=f['trigger'])
                trades.append(ep);del episodes[symbol]
        fills.append(f)
    if not full: raise ValueError('No complete account snapshots')
    closes={day(s['asof']):dict(at=s['asof'],**s['account']) for s in full if s.get('review_only')}
    all_samples=[dict(at=s['asof'],**s['account']) for s in snapshots if 'account' in s]
    start,final=D(full[0]['account']['equity']),D(full[-1]['account']['equity'])
    sells=[f for f in fills if f['action']=='SELL'];realized=sum((f['net_pnl'] for f in sells),D(0))
    gains=sum((t['pnl'] for t in trades if t['pnl']>0),D(0));losses=-sum((t['pnl'] for t in trades if t['pnl']<0),D(0))
    wins,lost=sum(t['pnl']>0 for t in trades),sum(t['pnl']<0 for t in trades)
    exposure=lambda a:sum((D(p['last_price'])*p['shares'] for p in a['positions']),D(0))/D(a['equity'])*100
    summary=dict(export_version=document.get('version'),source_commit=document.get('build',{}).get('source_commit'),build=document.get('build'),
        version_assurance='Export declares a version, not a commit or signed binary identity',events=len(events),
        stage_counts=dict(collections.Counter(e['stage'] for e in events)),initial_equity=start,final_equity=final,return_pct=(final/start-1)*100,
        fills=len(fills),buys=sum(f['action']=='BUY' for f in fills),sells=len(sells),closed_trades=len(trades),wins=wins,losses=lost,
        realized_net_pnl=realized,unrealized_after_buy_fees=final-start-realized,
        completed_trade_costs=sum((t['total_costs'] for t in trades),D(0)),all_fill_costs=sum((f['fee']+f['tax'] for f in fills),D(0)),
        win_rate_pct=D(wins)/len(trades)*100 if trades else None,average_win=gains/wins if wins else None,average_loss=losses/lost if lost else None,
        expectancy=sum((t['pnl'] for t in trades),D(0))/len(trades) if trades else None,profit_factor=gains/losses if losses else None,
        observed_snapshots=drawdown(all_samples),postmarket=drawdown(list(closes.values())),
        average_close_exposure_pct=sum((exposure(a) for a in closes.values()),D(0))/len(closes) if closes else None,
        models=[dict(model=k[0],reasoning=k[1],calls=v) for k,v in models.items()],model_call_types=dict(calls),token_usage=dict(usage),
        active_limits=full[0]['hard_limits'],limitations=[
            'No full minute history, real odd-lot books, order/fill IDs or broker timestamps in export.',
            'Virtual delay is simulation time, not network latency. Limit price is not a contemporaneous midquote.',
            'Snapshot drawdown is a lower bound on intraday MDD; open PnL excludes future liquidation costs.',
            'FIFO is exact for known lots; account snapshots are authoritative for total equity. Diagnostic month is not OOS.'])
    return dict(summary=summary,events=events,fills=fills,trades=trades,snapshots=snapshots,daily_equity=list(closes.values()),sizing=sizing,open_episodes=list(episodes.values()))
def encode(value):
    if isinstance(value,D): return str(value)
    raise TypeError(type(value).__name__)
def write_outputs(result,directory):
    directory.mkdir(parents=True,exist_ok=True)
    for key in ['summary','trades','sizing','daily_equity','open_episodes']:
        (directory/(key+'.json')).write_text(json.dumps(result[key],ensure_ascii=False,indent=2,default=encode)+'\n',encoding='utf-8')
    for key in ['events','snapshots']:
        (directory/(key+'.jsonl')).write_text(''.join(json.dumps(row,ensure_ascii=False,default=encode)+'\n' for row in result[key]),encoding='utf-8')
    for key in ['fills','trades','sizing','daily_equity']:
        rows=result[key];fields=list(dict.fromkeys(k for row in rows for k in row))
        with (directory/(key+'.csv')).open('w',newline='',encoding='utf-8-sig') as stream:
            writer=csv.DictWriter(stream,fieldnames=fields);writer.writeheader()
            writer.writerows({k:json.dumps(v,ensure_ascii=False,default=encode) if isinstance(v,(dict,list)) else v for k,v in row.items()} for row in rows)
def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('source',type=pathlib.Path);parser.add_argument('--output',type=pathlib.Path)
    args=parser.parse_args();raw=args.source.read_bytes();result=audit(json.loads(raw));result['summary']['source_sha256']=hashlib.sha256(raw).hexdigest()
    if args.output: write_outputs(result,args.output)
    print(json.dumps(result['summary'],ensure_ascii=False,indent=2,default=encode))
if __name__=='__main__': main()
