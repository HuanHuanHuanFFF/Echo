import sys,json,pathlib,statistics,collections,math,hashlib
root=pathlib.Path(sys.argv[1]).resolve();sys.path.insert(0,str(root/'scoring-tools'))
import numpy as np
def load(p):
 with open(p,encoding='utf8') as f:return [json.loads(l) for l in f if l.strip()]
arms={a:load(root/f'qasper/{a}-results.jsonl') for a in ['p0','p1','p2']}
queries={r['id']:r for r in load(root/'prepared/qasper-queries.jsonl')}
summary={}
for arm,rows in arms.items():
 eligible=[r for r in rows if r['score']['eligible']]
 bucket={}
 for n in [1,2,3,4]:
  group=[r for r in eligible if min(min(len(a['evidence']),4) for a in queries[r['id']]['annotations'] if a['valid'])==n]
  bucket[str(n)+'+' if n==4 else str(n)]={'n':len(group),'complete':sum(r['score']['strict_complete'] for r in group),'coverage':statistics.mean(r['score']['strict_coverage'] for r in group) if group else None}
 summary[arm]={'questions':len(rows),'eligible':len(eligible),'complete':sum(r['score']['strict_complete'] for r in eligible),'coverage':statistics.mean(r['score']['strict_coverage'] for r in eligible),'paragraph_f1_all':statistics.mean(r['score']['official_formula_evidence_f1'] for r in rows),'total_context_chars':sum(r['request_chars']+r['response_chars'] for r in rows),'mean_context_chars':statistics.mean(r['request_chars']+r['response_chars'] for r in rows),'mean_chunks':statistics.mean(len(r['result']['results']) for r in rows),'mean_selected_paragraphs':statistics.mean(len(r['score']['selected_paragraphs']) for r in rows),'budget_exclusion_questions':sum(r['result']['excluded']['budget']>0 for r in rows),'source_cap_questions':sum(r['result']['excluded']['source_limit']>0 for r in rows),'offline_p50_ms':float(np.quantile([r['offline_ms'] for r in rows],.5)),'offline_p95_ms':float(np.quantile([r['offline_ms'] for r in rows],.95)),'evidence_count_buckets':bucket}
pairs={}
for left,right in [('p0','p1'),('p1','p2'),('p0','p2')]:
 a={r['id']:r for r in arms[left]};b={r['id']:r for r in arms[right]}
 good=[q for q in a if a[q]['score']['eligible']]
 wins=[q for q in good if not a[q]['score']['strict_complete'] and b[q]['score']['strict_complete']]
 losses=[q for q in good if a[q]['score']['strict_complete'] and not b[q]['score']['strict_complete']]
 grouped=collections.defaultdict(list)
 for q in good:grouped[a[q]['paper_id']].append(q)
 clusters=list(grouped.values())
 deltas=np.array([[sum(int(b[q]['score']['strict_complete'])-int(a[q]['score']['strict_complete']) for q in g),sum(b[q]['score']['strict_coverage']-a[q]['score']['strict_coverage'] for q in g),len(g)] for g in clusters])
 rng=np.random.default_rng(20260919);boot=[]
 for _ in range(10000):
  sample=deltas[rng.integers(0,len(deltas),len(deltas))].sum(axis=0);boot.append(sample[:2]/sample[2])
 ci=np.quantile(np.array(boot),[.025,.975],axis=0)
 pairs[left+'->'+right]={'wins':len(wins),'losses':len(losses),'win_ids':wins,'loss_ids':losses,'paper_clusters':len(clusters),'complete_difference':(len(wins)-len(losses))/len(good),'complete_ci95':ci[:,0].tolist(),'coverage_ci95':ci[:,1].tolist(),'bootstrap_iterations':10000,'seed':20260919}
receipt={'scope':'QASPER validation','summary':summary,'paired':pairs,'limitations':['No answer generation','Official all1005 paragraph F1 and strict800 completeness are different metrics','Offline latency excludes API; original paper scope and per-source cap3','Official heuristic baselines choose one paragraph; not equal context budget']}
(root/'analysis/qasper-analysis.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf8')
print(json.dumps({'summary':summary,'paired':{k:{a:b for a,b in v.items() if not a.endswith('_ids')} for k,v in pairs.items()}}))
